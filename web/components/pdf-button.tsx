"use client";

// The record "PDF" button — lives in every transaction flyout's headerActions.
// Click prints the record with the org's default template (or the built-in
// starter design). When the org has more than one template for the record
// type, a picker menu opens instead so the user chooses the design. A record
// that has not been saved yet has nothing to print, so the button waits for
// the first save. The PDF is fetched before it is shown: a refusal renders as
// the server's reason in a toast, never as a raw response in a new tab.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { Button, ContextMenu, useContextMenu, type ContextMenuEntry } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

export function PdfButton({
  recordType,
  recordId,
  label,
  disabled = false,
}: {
  recordType: string;
  recordId: string;
  label?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("pdfTemplates");
  const menu = useContextMenu();
  const [items, setItems] = useState<ContextMenuEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const pdfHref = (templateId?: string) =>
    `/api/record-pdf/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}` +
    (templateId ? `?template=${encodeURIComponent(templateId)}` : "");

  // The tab opens inside the click so popup blocking never applies, and shows
  // the PDF only once the server has produced one.
  async function openPdf(templateId?: string) {
    const tab = window.open("", "_blank");
    try {
      const res = await fetch(pdfHref(templateId));
      if (!res.ok) {
        tab?.close();
        toast.error(await readApiErrorMessage(res, t("pdfButton.printFailed")));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      tab?.close();
      toast.error(t("pdfButton.printFailed"));
    }
  }

  async function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    const anchor = e.currentTarget;
    let entries = items;
    if (!entries) {
      setBusy(true);
      try {
        const res = await fetch(`/api/record-pdf/${encodeURIComponent(recordType)}/options`);
        // The refusal reads through the shared helper so the server's reason
        // renders instead of a bare fallback.
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t("pdfButton.failed")));
          return;
        }
        const data = (await res.json()) as {
          rows: { id: string; name: string; isDefault: boolean }[];
        };
        entries =
          data.rows.length > 1
            ? data.rows.map((r) => ({
                key: r.id,
                label: r.isDefault ? `${r.name} ★` : r.name,
                onSelect: () => void openPdf(r.id),
              }))
            : [];
        setItems(entries);
      } finally {
        setBusy(false);
      }
    }
    if (entries.length > 0) menu.openBelow(anchor);
    else await openPdf();
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={onClick}
        disabled={busy || disabled || !recordId}
        title={recordId ? undefined : t("pdfButton.saveFirst")}
      >
        <FileText size={15} className="mr-1.5" />
        {label ?? t("pdfButton.label")}
      </Button>
      <ContextMenu
        open={menu.open}
        position={menu.position}
        items={items ?? []}
        onClose={menu.close}
      />
    </>
  );
}
