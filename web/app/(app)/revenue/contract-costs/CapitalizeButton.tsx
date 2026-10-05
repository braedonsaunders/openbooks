"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Drawer, Input, SearchSelect, Select } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

/**
 * Capitalize a commission from the workspace: the journal preview (DR
 * asset / CR original expense) is computed from the entered amount before
 * anything posts — consequence before commit.
 */
export function CapitalizeButton({
  contracts,
  expenseAccounts,
  policy,
  baseCurrency,
}: {
  contracts: { id: string; number: string; customer: string }[];
  expenseAccounts: { value: string; label: string }[];
  policy: { assetAccountId: string | null } | null;
  baseCurrency: string;
}) {
  const t = useTranslations("contractCosts");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contractId, setContractId] = useState("");
  const [costType, setCostType] = useState("commission");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/revenue/contract-costs/capitalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revenueContractId: contractId || undefined,
          costType,
          amount,
          currency: baseCurrency,
          capitalizedOn: date,
          originalExpenseAccountId: expenseAccountId || undefined,
        }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("capitalize.failed")));
      const result = (await res.json()) as { assetId: string; status: string };
      toast.success(t("capitalize.saved", { status: result.status }));
      setOpen(false);
      router.push(`/revenue/contract-costs?asset=${result.assetId}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("capitalize.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("capitalize.open")}</Button>
      {open && (
        <Drawer
          open
          onClose={() => setOpen(false)}
          title={t("capitalize.title")}
          description={t("capitalize.description")}
        >
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("capitalize.contract")}</label>
              <SearchSelect
                value={contractId}
                options={contracts.map((c) => ({ value: c.id, label: `${c.number} · ${c.customer}` }))}
                onChange={(v) => setContractId(v ?? "")}
                ariaLabel={t("capitalize.contract")}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("capitalize.costType")}</label>
              <Select value={costType} onChange={(e) => setCostType(e.target.value)}>
                <option value="commission">{t("costType.commission")}</option>
                <option value="fulfilment">{t("costType.fulfilment")}</option>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("capitalize.amount", { currency: baseCurrency })}</label>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1200.00" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("capitalize.date")}</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("capitalize.expenseAccount")}</label>
              <SearchSelect
                value={expenseAccountId}
                options={expenseAccounts}
                onChange={(v) => setExpenseAccountId(v ?? "")}
                ariaLabel={t("capitalize.expenseAccount")}
              />
            </div>
            {amount && policy?.assetAccountId && (
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                {t("capitalize.preview", { amount, currency: baseCurrency })}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={submit} disabled={busy || !amount || !date || !expenseAccountId}>
                {t("capitalize.submit")}
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}
