"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Drawer, SearchSelect, Textarea } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

/**
 * Import CaptivateIQ/QuotaPath-style commission rows pasted as CSV
 * (contract number, amount, date per line). Every row answers for itself;
 * the result names what capitalized, what queued, and what refused with
 * its remedy.
 */
const COLUMNS = ["contractNumber", "amount", "date"] as const;

/** One per-row answer from the import API (the engine's CommissionImportResult). */
type ImportRowResult = { assetId: string | null; ok: boolean; error?: string; remedy?: string };

export function ImportCommissionsButton({
  expenseAccounts,
  baseCurrency,
}: {
  expenseAccounts: { value: string; label: string }[];
  baseCurrency: string;
}) {
  const t = useTranslations("contractCosts");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [report, setReport] = useState<{ ok: number; refused: ImportRowResult[] } | null>(null);

  async function submit() {
    const rows = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [contractNumber, amount, date] = line.split(/[,;\t]/).map((cell) => cell.trim());
        return { contractNumber, amount, date };
      });
    if (rows.some((row) => !row.contractNumber || !row.amount || !row.date) || !expenseAccountId) {
      toast.error(t("import.badShape", { columns: COLUMNS.join(", ") }));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/revenue/contract-costs/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: rows.map((row, i) => ({
            contractNumber: row.contractNumber,
            amount: row.amount,
            currency: baseCurrency,
            date: row.date,
            originalExpenseAccountId: expenseAccountId,
            ref: t("import.rowRef", { index: i + 1 }),
          })),
        }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("import.failed")));
      const result = (await res.json()) as { rows: ImportRowResult[] };
      const ok = result.rows.filter((row) => row.ok).length;
      const refused = result.rows.filter((row) => !row.ok);
      setReport({ ok, refused });
      if (refused.length === 0) toast.success(t("import.saved", { count: ok }));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("import.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => { setReport(null); setOpen(true); }}>
        {t("import.open")}
      </Button>
      {open && (
        <Drawer
          open
          onClose={() => setOpen(false)}
          title={t("import.title")}
          description={t("import.description", { columns: COLUMNS.join(", "), currency: baseCurrency })}
        >
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("import.expenseAccount")}</label>
              <SearchSelect
                value={expenseAccountId}
                options={expenseAccounts}
                onChange={(v) => setExpenseAccountId(v ?? "")}
                ariaLabel={t("import.expenseAccount")}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("import.rows")}</label>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder="C-1024, 1200.00, 2026-07-15" />
            </div>
            {report && (
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                {t("import.report", { ok: report.ok, refused: report.refused.length })}
                {report.refused.slice(0, 3).map((row, i) => (
                  <span key={i} className="mt-1 block">
                    {row.error} {row.remedy}
                  </span>
                ))}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={submit} disabled={busy || !text.trim() || !expenseAccountId}>
                {t("import.submit")}
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}
