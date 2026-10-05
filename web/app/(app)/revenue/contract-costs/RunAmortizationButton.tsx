"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Drawer, SearchSelect } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

/** Run amortization for one period: one line per due asset, skips the rest. */
export function RunAmortizationButton({
  periods,
  selectedPeriodId,
  activeAssets,
}: {
  periods: { id: string; name: string }[];
  selectedPeriodId: string | null;
  activeAssets: number;
}) {
  const t = useTranslations("contractCosts");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [periodId, setPeriodId] = useState(selectedPeriodId ?? "");

  async function submit() {
    if (!periodId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/revenue/contract-costs/run-amortization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("run.failed")));
      const result = (await res.json()) as { posted: number; skipped: number; problems: string[] };
      toast.success(t("run.saved", { posted: result.posted, skipped: result.skipped }));
      for (const problem of result.problems) toast.warning(problem);
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("run.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t("run.open")}
      </Button>
      {open && (
        <Drawer
          open
          onClose={() => setOpen(false)}
          title={t("run.title")}
          description={t("run.description", { count: activeAssets })}
        >
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("run.period")}</label>
              <SearchSelect
                value={periodId}
                options={periods.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(v) => setPeriodId(v ?? "")}
                ariaLabel={t("run.period")}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={submit} disabled={busy || !periodId}>
                {t("run.submit")}
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}
