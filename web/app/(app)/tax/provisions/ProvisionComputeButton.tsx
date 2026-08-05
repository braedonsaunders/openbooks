"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select } from "@openbooks/ui";

/** Compute dialog for a fiscal-year provision: permanent differences, loss
 *  carryforward used, valuation allowance, and manual temporary differences. */
export function ProvisionComputeButton() {
  const t = useTranslations("tax.provisions.compute");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [years, setYears] = useState<number[]>([]);
  const [framework, setFramework] = useState<"asc740" | "ias12">("asc740");
  const [fiscalYear, setFiscalYear] = useState<number | "">("");
  const [permanent, setPermanent] = useState([{ description: "", amount: "" }]);
  const [temporary, setTemporary] = useState([{ category: "other", description: "", difference: "" }]);
  const [lossUsed, setLossUsed] = useState("0");
  const [va, setVa] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void fetch("/api/tax/provisions").then(async (res) => {
      if (!res.ok) return;
      const json = (await res.json()) as { fiscalYears: number[]; framework: "asc740" | "ias12" };
      setYears(json.fiscalYears);
      setFramework(json.framework ?? "asc740");
      setFiscalYear((y) => y || json.fiscalYears[0] || "");
    });
  }, [open]);

  async function compute() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/tax/provisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fiscalYear,
        permanentDifferences: permanent.filter((p) => p.description && p.amount),
        additionalDifferences: temporary.filter((d) => d.description && d.difference),
        lossCarryforwardUsed: lossUsed || "0",
        valuationAllowance: va || "0",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? res.statusText);
      return;
    }
    setOpen(false);
    router.push(`/tax/provisions/${json.runId}`);
    router.refresh();
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("button")}</Button>
      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">{t("title")}</h2>
            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label>{t("fiscalYear")}</Label>
                <Select value={String(fiscalYear)} onChange={(e) => setFiscalYear(Number(e.target.value))}>
                  {years.map((y) => (
                    <option key={y} value={y}>FY{y}</option>
                  ))}
                </Select>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("permanent")}</legend>
                {permanent.map((p, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      placeholder={t("descriptionPlaceholder")}
                      value={p.description}
                      onChange={(e) => setPermanent((rows) => rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)))}
                    />
                    <Input
                      className="w-32"
                      placeholder="0.00"
                      value={p.amount}
                      onChange={(e) => setPermanent((rows) => rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
                    />
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setPermanent((r) => [...r, { description: "", amount: "" }])}>
                  {t("addLine")}
                </Button>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("temporary")}</legend>
                {temporary.map((d, i) => (
                  <div key={i} className="flex gap-2">
                    <Select
                      value={d.category}
                      onChange={(e) => setTemporary((rows) => rows.map((r, j) => (j === i ? { ...r, category: e.target.value } : r)))}
                    >
                      <option value="fixed_assets">{t("categories.fixed_assets")}</option>
                      <option value="revenue_recognition">{t("categories.revenue_recognition")}</option>
                      <option value="provisions">{t("categories.provisions")}</option>
                      <option value="loss_carryforward">{t("categories.loss_carryforward")}</option>
                      <option value="other">{t("categories.other")}</option>
                    </Select>
                    <Input
                      placeholder={t("descriptionPlaceholder")}
                      value={d.description}
                      onChange={(e) => setTemporary((rows) => rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)))}
                    />
                    <Input
                      className="w-32"
                      placeholder="0.00"
                      value={d.difference}
                      onChange={(e) => setTemporary((rows) => rows.map((r, j) => (j === i ? { ...r, difference: e.target.value } : r)))}
                    />
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setTemporary((r) => [...r, { category: "other", description: "", difference: "" }])}>
                  {t("addLine")}
                </Button>
              </fieldset>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("lossUsed")}</Label>
                  <Input value={lossUsed} onChange={(e) => setLossUsed(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>{framework === "ias12" ? t("valuationAllowanceIas12") : t("valuationAllowance")}</Label>
                  <Input value={va} onChange={(e) => setVa(e.target.value)} />
                </div>
              </div>

              {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
                <Button disabled={busy || !fiscalYear} onClick={() => void compute()}>
                  {busy ? t("computing") : t("compute")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
