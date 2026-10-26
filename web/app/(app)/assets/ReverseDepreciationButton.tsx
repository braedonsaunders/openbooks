"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Label, Popover, Textarea } from "@openbooks/ui";
import { fetchAppAction } from "@/lib/api-error";
import { useAppAction } from "@/lib/use-app-action";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";

/** A correction retains the original date, amount and journal in its audit chain. */
export function ReverseDepreciationButton({
  assetId,
  lineId,
}: {
  assetId: string;
  lineId: string;
}) {
  const t = useTranslations("assets.depreciationCorrection");
  const router = useRouter(),
    id = useId();
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState("");
  const action = useAppAction();
  async function submit() {
    const ok = await action.execute(
      () =>
        fetchAppAction<{
          status: "applied" | "pending_approval";
          changeId: string;
        }>(
          `/api/assets/${assetId}/reverse-depreciation`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lineId, reason }),
          },
          { fallback: t("failed") },
        ),
      {
        fallbackMessage: t("failed"),
        onOk: (result) => {
          if (result.status === "pending_approval")
            router.push(`/accounting/changes?change=${result.changeId}`);
        },
      },
    );
    if (ok) {
      setOpen(false);
      setReason("");
      router.refresh();
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {t("action")}
        </Button>
      }
    >
      <div className="w-80 space-y-3 p-3">
        <p className="text-sm">{t("help")}</p>
        <Label htmlFor={id}>{t("reason")}</Label>
        <Textarea
          id={id}
          value={reason}
          disabled={action.busy}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        <ActionAlert error={action.refusal} fallbackMessage={t("failed")} />
        <Button disabled={action.busy || reason.trim().length < 8} onClick={submit}>
          {t("action")}
        </Button>
      </div>
    </Popover>
  );
}
