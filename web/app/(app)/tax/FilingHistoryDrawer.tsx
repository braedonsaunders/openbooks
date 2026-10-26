"use client";

import {
  Table as SharedTable,
  TableHeader as SharedTableHeader,
  TableRow as SharedTableRow,
  TableHead as SharedTableHead,
  TableBody as SharedTableBody,
  TableCell as SharedTableCell,
} from "@openbooks/ui";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Badge, Button, Input, Label, UrlDrawer } from "@openbooks/ui";
import { formatDecimal } from "../../../lib/money-format";

/** One adjustment entry on a stored filing, with the author who recorded it. */
export type FilingAdjustmentRecord = {
  lineCode: string;
  amount: string;
  reason: string | null;
  enteredByName: string | null;
  enteredAt: string | null;
};

export type FilingHistoryRecord = {
  id: string;
  form_name: string;
  form_code: string;
  country: string | null;
  period_from: string;
  period_to: string;
  version: number;
  status: "prepared" | "filed";
  filing_reference: string | null;
  filed_at: string | null;
  snapshot_hash: string;
  boxes: { lineCode: string; label: string; value: string; computed: boolean; editable: boolean }[];
  adjustments: FilingAdjustmentRecord[];
};

export function FilingHistoryDrawer({
  filing,
  closeHref,
  canFile,
}: {
  filing: FilingHistoryRecord;
  closeHref: string;
  canFile: boolean;
}) {
  const t = useTranslations("tax.history");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [reference, setReference] = useState(filing.filing_reference ?? "");
  const [busy, setBusy] = useState(false);

  const [markError, setMarkError] = useState<string | null>(null);

  /** Map a typed mark-filed refusal to localized copy. */
  function markFiledMessage(data: { code?: unknown; error?: unknown }): string {
    const code = typeof data.code === "string" ? data.code : null;
    if (code === "period-not-closed") return t("errors.periodNotClosed");
    if (code === "already-filed") return t("errors.alreadyFiled");
    if (code === "stale") return t("errors.stale");
    return typeof data.error === "string" && data.error
      ? data.error
      : tCommon("feedback.saveFailed");
  }

  async function markFiled() {
    setBusy(true);
    setMarkError(null);
    try {
      const response = await fetch(`/api/tax/filings/${filing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filingReference: reference }),
      });
      // A 409 names its remedy (close the period, refresh the snapshot):
      // surface it inline and in the toast, never as a generic save failure.
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(markFiledMessage(data));
      }
      toast.success(t("filedSuccess"));
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : tCommon("feedback.saveFailed");
      setMarkError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={filing.form_name}
      description={t("drawerDescription", {
        from: filing.period_from,
        to: filing.period_to,
        version: filing.version,
      })}
      headerActions={
        <Badge variant={filing.status === "filed" ? "success" : "warning"}>
          {t(`status.${filing.status}`)}
        </Badge>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {(["pdf", "xlsx", "csv"] as const).map((format) => (
            <a key={format} href={`/api/tax/filings/${filing.id}/export?format=${format}`}>
              <Button variant="outline" size="sm">
                <Download size={14} />
                {t(`export.${format}`)}
              </Button>
            </a>
          ))}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{t("formCode")}</dt>
            <dd className="font-mono text-xs">{filing.form_code}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{t("country")}</dt>
            <dd>{filing.country ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{t("reference")}</dt>
            <dd>{filing.filing_reference ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{t("filedAt")}</dt>
            <dd>{filing.filed_at ? new Date(filing.filed_at).toLocaleString(locale) : "—"}</dd>
          </div>
        </dl>
        {filing.status === "prepared" && canFile ? (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <Label htmlFor="filing-reference">{t("reference")}</Label>
            <Input
              id="filing-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder={t("referencePlaceholder")}
              maxLength={200}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("markFiledHint")}</p>
            <Button onClick={markFiled} disabled={busy}>
              {busy ? t("markingFiled") : t("markFiled")}
            </Button>
            {markError ? (
              <p role="alert" className="text-xs font-medium text-red-700 dark:text-red-300">
                {markError}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader>
              <SharedTableRow className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <SharedTableHead className="px-3 py-2">{t("line")}</SharedTableHead>
                <SharedTableHead className="px-3 py-2">{t("lineDescription")}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 text-right">{t("amount")}</SharedTableHead>
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {filing.boxes.map((box) => (
                <SharedTableRow
                  key={box.lineCode}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <SharedTableCell className="px-3 py-2 font-mono text-xs">
                    {box.lineCode}
                  </SharedTableCell>
                  <SharedTableCell className="px-3 py-2">{box.label}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2 text-right tabular-nums">
                    {formatDecimal(locale, box.value, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </SharedTableCell>
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </div>
        {filing.adjustments.length > 0 ? (
          <section aria-labelledby="filing-adjustments-heading" className="space-y-2">
            <h3
              id="filing-adjustments-heading"
              className="text-sm font-semibold text-slate-900 dark:text-slate-100"
            >
              {t("adjustments.title")}
            </h3>
            <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader>
                  <SharedTableRow className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                    <SharedTableHead className="px-3 py-2">{t("line")}</SharedTableHead>
                    <SharedTableHead className="px-3 py-2">
                      {t("adjustments.reason")}
                    </SharedTableHead>
                    <SharedTableHead className="px-3 py-2">
                      {t("adjustments.recordedBy")}
                    </SharedTableHead>
                    <SharedTableHead className="px-3 py-2 text-right">
                      {t("amount")}
                    </SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {filing.adjustments.map((entry, index) => (
                    <SharedTableRow
                      key={`${entry.lineCode}-${index}`}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <SharedTableCell className="px-3 py-2 font-mono text-xs">
                        {entry.lineCode}
                      </SharedTableCell>
                      <SharedTableCell className="px-3 py-2">
                        {entry.reason ?? t("adjustments.noReason")}
                      </SharedTableCell>
                      <SharedTableCell className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                        {[
                          entry.enteredByName ?? null,
                          entry.enteredAt ? new Date(entry.enteredAt).toLocaleString(locale) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </SharedTableCell>
                      <SharedTableCell className="px-3 py-2 text-right tabular-nums">
                        {formatDecimal(locale, entry.amount, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </div>
          </section>
        ) : null}
        <p className="break-all text-xs text-slate-400 dark:text-slate-500">
          {t("hash", { hash: filing.snapshot_hash })}
        </p>
      </div>
    </UrlDrawer>
  );
}
