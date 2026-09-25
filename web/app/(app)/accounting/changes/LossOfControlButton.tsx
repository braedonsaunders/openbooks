"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Button,
  Drawer,
  Input,
  Label,
  SearchSelect,
  Select,
  Textarea,
} from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { useTranslations } from "next-intl";
type Setup = {
  interest: { investment_account_id: string; equity_income_account_id: string };
  subsidiaries: { id: string; name: string; base_currency: string }[];
  accounts: { id: string; number: string; name: string; type: string }[];
  eliminations: { id: string; name: string; base_currency: string }[];
  adjustmentLines: {
    id: string;
    entry_number: string;
    posting_date: string;
    account_name: string;
    amount: string;
    memo: string | null;
  }[];
};
type Oci = {
  accountId: string;
  balance: string;
  treatment: "profit_loss" | "retained_earnings";
  destinationAccountId: string;
  description: string;
};
/** Same stacked Drawer, input controls and proposal handoff as lease and asset
 * changes. There is no second approval UI: the prepared evidence enters Flows. */
export function LossOfControlButton({ interestId }: { interestId: string }) {
  const router = useRouter(),
    today = useBusinessToday();
  const tc = useTranslations("common");
  const t = useTranslations("accounting.lifecycle.lossOfControl");
  const fieldId = useId();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [setup, setSetup] = useState<Setup | null>(null),
    [values, setValues] = useState<Record<string, string>>({
      effectiveOn: today,
      retainedMethod: "none",
      parentRetainedCarrying: "0",
      retainedPercent: "0",
      retainedFairValue: "0",
    }),
    [rates, setRates] = useState<Record<string, string>>({}),
    [oci, setOci] = useState<Oci[]>([]),
    [adjustments, setAdjustments] = useState<
      { lineId: string; amount: string }[]
    >([]),
    [dirty, setDirty] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const changed = () => {
    setDirty(true);
    setKey(crypto.randomUUID());
    setError(null);
  };
  const closeDrawer = () => {
    setOpen(false);
    setDirty(false);
  };
  const closeGuard = useDirtyClose({
    dirty, busy, onClose: closeDrawer,
    message: tc("feedback.unsavedChanges"), confirmLabel: tc("confirm.discardChanges"),
  });
  const set = (name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    changed();
  };
  async function show() {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/consolidation/interests/${interestId}/loss-of-control`,
      );
      if (!r.ok) {
        // The route refuses by name in an `{error}` body (invalid interest,
        // unmet proposal preconditions): surface the refusal, not a generic
        // load failure.
        const problem = (await r.json().catch(() => null)) as { error?: unknown } | null;
        const refusal = typeof problem?.error === "string" && problem.error ? problem.error : null;
        throw new Error(refusal ?? t("loadFailed"));
      }
      const s = (await r.json()) as Setup;
      setSetup(s);
      setValues((v) => ({
        ...v,
        retainedAccountId: s.interest.investment_account_id,
        equityIncomeAccountId: s.interest.equity_income_account_id,
      }));
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("loadFailed"));
    } finally {
      setBusy(false);
    }
  }
  const accountOptions =
    setup?.accounts.map((a) => ({
      value: a.id,
      label: `${a.number} — ${a.name}`,
    })) ?? [];
  const field = (name: string, label: string, type = "text") => (
    <div key={name} className="space-y-1.5">
      <Label htmlFor={`${fieldId}-${name}`}>{label}</Label>
      <Input
        id={`${fieldId}-${name}`}
        type={type}
        disabled={busy}
        value={values[name] ?? ""}
        onChange={(e) => set(name, e.target.value)}
      />
    </div>
  );
  const account = (name: string, label: string) => (
    <div key={name} className="space-y-1.5">
      <Label htmlFor={`${fieldId}-${name}`}>{label}</Label>
      <SearchSelect
        id={`${fieldId}-${name}`}
        disabled={busy}
        ariaLabel={label}
        value={values[name] ?? ""}
        onChange={(v) => set(name, v)}
        options={accountOptions}
      />
    </div>
  );
  const memo = (name: string, label: string) => (
    <div key={name} className="space-y-1.5">
      <Label htmlFor={`${fieldId}-${name}`}>{label}</Label>
      <Textarea
        id={`${fieldId}-${name}`}
        disabled={busy}
        value={values[name] ?? ""}
        onChange={(e) => set(name, e.target.value)}
      />
    </div>
  );
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/consolidation/interests/${interestId}/loss-of-control`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...values,
            idempotencyKey: key,
            distributionAccountId: values.distributionAccountId || null,
            distributionIncomeAccountId:
              values.distributionIncomeAccountId || null,
            rates: setup!.subsidiaries.map((s) => ({
              subsidiaryId: s.id,
              rate: rates[s.id] ?? "",
            })),
            oci,
            additionalConsolidationLines: adjustments,
          }),
        },
      );
      if (!r.ok) {
        // The POST refuses by name in an `{error}` body (engine refusal):
        // surface the refusal instead of discarding it for prepareFailed.
        const problem = (await r.json().catch(() => null)) as { error?: unknown } | null;
        const refusal = typeof problem?.error === "string" && problem.error ? problem.error : null;
        throw new Error(refusal ?? t("prepareFailed"));
      }
      const result = (await r.json()) as { changeId: string };
      closeDrawer();
      router.push(`/accounting/changes?change=${result.changeId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("prepareFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={show}>
        {t("recordButton")}
      </Button>
      <Drawer
        stacked
        open={open}
        onClose={closeGuard.close}
        title={t("title")}
        description={t("description")}
        size="2xl"
        footer={
          <Button disabled={busy} onClick={prepare}>
            {t("prepare")}
          </Button>
        }
      >
        <div className="space-y-5">
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            {field("effectiveOn", t("effectiveOn"), "date")}
            {field("reason", t("reason"))}
          </div>
          {memo("assessment", t("assessment"))}
          <div>
            <Label htmlFor={`${fieldId}-elimination-entity`}>{t("eliminationEntity")}</Label>
            <SearchSelect
              id={`${fieldId}-elimination-entity`}
              disabled={busy}
              ariaLabel={t("eliminationEntity")}
              value={values.eliminationSubsidiaryId ?? ""}
              onChange={(v) => set("eliminationSubsidiaryId", v)}
              options={
                setup?.eliminations.map((s) => ({
                  value: s.id,
                  label: `${s.name} · ${s.base_currency}`,
                })) ?? []
              }
            />
          </div>
          <section className="space-y-3">
            <h3 className="font-semibold">{t("parentBooks")}</h3>
            <p className="text-sm text-slate-500">{t("parentBooksHelp")}</p>
            <div className="grid grid-cols-2 gap-4">
              {field("proceeds", t("proceeds"))}
              {field("parentInvestmentCarrying", t("carryingAmount"))}
              {field("parentToGroupRate", t("parentToGroupRate"))}
              {account("proceedsAccountId", t("proceedsAccount"))}
              {account("parentGainLossAccountId", t("gainLossAccount"))}
              {account("gainLossAccountId", t("groupGainLossAccount"))}
              {account(
                "investmentTranslationAccountId",
                t("translationReserveAccount"),
              )}
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">{t("retainedInterest")}</h3>
            <Select
              aria-label={t("retainedMethod")}
              disabled={busy}
              value={values.retainedMethod}
              onChange={(e) => {
                set("retainedMethod", e.target.value);
                if (e.target.value === "none")
                  setValues((v) => ({
                    ...v,
                    parentRetainedCarrying: "0",
                    retainedPercent: "0",
                    retainedFairValue: "0",
                  }));
              }}
            >
              {[
                { value: "none", label: t("methodNone") },
                { value: "equity", label: t("methodEquity") },
                { value: "financial_asset", label: t("methodFinancialAsset") },
              ].map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            {values.retainedMethod !== "none" ? (
              <div className="grid grid-cols-2 gap-4">
                {field("retainedPercent", t("retainedPercent"))}
                {field("parentRetainedCarrying", t("retainedCarrying"))}
                {field("retainedFairValue", t("retainedFairValue"))}
                {account("retainedAccountId", t("retainedAccount"))}
                {values.retainedMethod === "equity" ? (
                  <>
                    {account("equityIncomeAccountId", t("equityIncomeAccount"))}
                    {account(
                      "distributionAccountId",
                      t("distributionsAccount"),
                    )}
                    {account(
                      "distributionIncomeAccountId",
                      t("distributionIncomeAccount"),
                    )}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">{t("ratesTitle")}</h3>
            <p className="text-sm text-slate-500">{t("ratesHelp")}</p>
            {setup?.subsidiaries.map((s) => (
              <div key={s.id}>
                <Label htmlFor={`${fieldId}-rate-${s.id}`}>
                  {s.name} · {s.base_currency}
                </Label>
                <Input
                  id={`${fieldId}-rate-${s.id}`}
                  disabled={busy}
                  value={rates[s.id] ?? ""}
                  onChange={(e) => {
                    setRates((v) => ({ ...v, [s.id]: e.target.value }));
                    changed();
                  }}
                />
              </div>
            ))}
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">{t("adjustmentsTitle")}</h3>
            <p className="text-sm text-slate-500">{t("adjustmentsHelp")}</p>
            {adjustments.map((line, i) => (
              <div key={i} className="space-y-2">
                <SearchSelect
                  ariaLabel={t("adjustmentLine")}
                  disabled={busy}
                  value={line.lineId}
                  onChange={(id) => {
                    setAdjustments((rows) =>
                      rows.map((r, n) =>
                        n === i
                          ? {
                              lineId: id,
                              amount:
                                setup?.adjustmentLines.find((l) => l.id === id)
                                  ?.amount ?? "",
                            }
                          : r,
                      ),
                    );
                    changed();
                  }}
                  options={
                    setup?.adjustmentLines.map((l) => ({
                      value: l.id,
                      label: `${l.posting_date} · ${l.entry_number} · ${l.account_name} · ${l.amount}`,
                    })) ?? []
                  }
                />
                <Input
                  aria-label={t("attributedAmount")}
                  disabled={busy}
                  value={line.amount}
                  onChange={(e) => {
                    setAdjustments((rows) =>
                      rows.map((r, n) =>
                        n === i ? { ...r, amount: e.target.value } : r,
                      ),
                    );
                    changed();
                  }}
                />
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setAdjustments((rows) => rows.filter((_, n) => n !== i));
                    changed();
                  }}
                >
                  {t("removeAdjustment")}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setAdjustments((rows) => [...rows, { lineId: "", amount: "" }]);
                changed();
              }}
            >
              {t("addAdjustment")}
            </Button>
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">{t("ociTitle")}</h3>
            {memo("ociAssessment", t("ociAssessment"))}
            <p className="text-sm text-slate-500">{t("ociHelp")}</p>
            {oci.map((line, i) => {
              const update = (patch: Partial<Oci>) => {
                setOci((rows) =>
                  rows.map((r, n) => (n === i ? { ...r, ...patch } : r)),
                );
                changed();
              };
              return (
                <div key={i} className="space-y-2">
                  <SearchSelect
                    ariaLabel={t("reserveAccount")}
                    disabled={busy}
                    value={line.accountId}
                    onChange={(accountId) => update({ accountId })}
                    options={accountOptions}
                    placeholder={t("reserveAccount")}
                  />
                  <Input
                    aria-label={t("reserveDescription")}
                    disabled={busy}
                    value={line.description}
                    onChange={(e) => update({ description: e.target.value })}
                  />
                  <Input
                    aria-label={t("reserveBalance")}
                    disabled={busy}
                    value={line.balance}
                    onChange={(e) => update({ balance: e.target.value })}
                  />
                  <Select
                    aria-label={t("reserveTreatment")}
                    disabled={busy}
                    value={line.treatment}
                    onChange={(e) =>
                      update({ treatment: e.target.value as Oci["treatment"] })
                    }
                  >
                    {[
                      {
                        value: "profit_loss",
                        label: t("treatmentProfitLoss"),
                      },
                      {
                        value: "retained_earnings",
                        label: t("treatmentRetainedEarnings"),
                      },
                    ].map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  <SearchSelect
                    ariaLabel={t("destinationAccount")}
                    disabled={busy}
                    value={line.destinationAccountId}
                    onChange={(destinationAccountId) =>
                      update({ destinationAccountId })
                    }
                    options={accountOptions}
                    placeholder={t("destinationAccount")}
                  />
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setOci((rows) => rows.filter((_, n) => n !== i));
                      changed();
                    }}
                  >
                    {t("removeReserve")}
                  </Button>
                </div>
              );
            })}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setOci((rows) => [
                  ...rows,
                  {
                    accountId: "",
                    balance: "",
                    treatment: "profit_loss",
                    destinationAccountId: "",
                    description: "",
                  },
                ]);
                changed();
              }}
            >
              {t("addReserve")}
            </Button>
          </section>
        </div>
      </Drawer>
    </>
  );
}
