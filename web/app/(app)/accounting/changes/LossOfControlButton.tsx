"use client";
import { useState } from "react";
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
    [key, setKey] = useState(() => crypto.randomUUID());
  const changed = () => {
    setKey(crypto.randomUUID());
    setError(null);
  };
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
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? "Unable to load disposal options");
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
      toast.error(e instanceof Error ? e.message : "Unable to open disposal");
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
      <Label htmlFor={`control-${name}`}>{label}</Label>
      <Input
        id={`control-${name}`}
        type={type}
        value={values[name] ?? ""}
        onChange={(e) => set(name, e.target.value)}
      />
    </div>
  );
  const account = (name: string, label: string) => (
    <div key={name} className="space-y-1.5">
      <Label>{label}</Label>
      <SearchSelect
        value={values[name] ?? ""}
        onChange={(v) => set(name, v)}
        options={accountOptions}
      />
    </div>
  );
  const memo = (name: string, label: string) => (
    <div key={name} className="space-y-1.5">
      <Label htmlFor={`control-${name}`}>{label}</Label>
      <Textarea
        id={`control-${name}`}
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
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? "Unable to prepare disposal");
      }
      const result = (await r.json()) as { changeId: string };
      setOpen(false);
      router.push(`/accounting/changes?change=${result.changeId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to prepare disposal");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={show}>
        Record loss of control
      </Button>
      <Drawer
        stacked
        open={open}
        onClose={() => setOpen(false)}
        title="Loss of control"
        description="Prepare the separate-book disposal and consolidated derecognition for independent approval. Posted history remains intact."
        size="2xl"
        footer={
          <Button disabled={busy} onClick={prepare}>
            Prepare for review
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
            {field("effectiveOn", "Control-loss date", "date")}
            {field("reason", "Reason")}
          </div>
          {memo(
            "assessment",
            "Control assessment, transaction evidence and attributed goodwill adjustments",
          )}
          <div>
            <Label>Consolidation entity and presentation currency</Label>
            <SearchSelect
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
            <h3 className="font-semibold">Parent’s separate books</h3>
            <p className="text-sm text-slate-500">
              Enter proceeds and carrying amounts in the parent’s functional
              currency. The proposal creates the disposal journal; do not book
              it separately.
            </p>
            <div className="grid grid-cols-2 gap-4">
              {field("proceeds", "Proceeds")}
              {field(
                "parentInvestmentCarrying",
                "Attributed investment carrying amount",
              )}
              {field(
                "parentToGroupRate",
                "Parent currency to group currency rate",
              )}
              {account("proceedsAccountId", "Proceeds account")}
              {account(
                "parentGainLossAccountId",
                "Separate-book gain or loss account",
              )}
              {account("gainLossAccountId", "Group gain or loss account")}
              {account(
                "investmentTranslationAccountId",
                "Investment translation reserve account",
              )}
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">Retained interest</h3>
            <Select
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
                { value: "none", label: "No interest retained" },
                { value: "equity", label: "Equity method" },
                { value: "financial_asset", label: "Financial asset" },
              ].map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            {values.retainedMethod !== "none" ? (
              <div className="grid grid-cols-2 gap-4">
                {field("retainedPercent", "Retained ownership (%)")}
                {field(
                  "parentRetainedCarrying",
                  "Retained carrying value in parent currency",
                )}
                {field(
                  "retainedFairValue",
                  "Retained fair value in group currency",
                )}
                {account("retainedAccountId", "Retained investment account")}
                {values.retainedMethod === "equity" ? (
                  <>
                    {account(
                      "equityIncomeAccountId",
                      "Equity-method income account",
                    )}
                    {account(
                      "distributionAccountId",
                      "Distributions account (optional)",
                    )}
                    {account(
                      "distributionIncomeAccountId",
                      "Distribution income account (if configured)",
                    )}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">Disposal-date closing rates</h3>
            <p className="text-sm text-slate-500">
              One unit of each functional currency expressed in group currency.
              Enter 1 for matching currencies.
            </p>
            {setup?.subsidiaries.map((s) => (
              <div key={s.id}>
                <Label>
                  {s.name} · {s.base_currency}
                </Label>
                <Input
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
            <h3 className="font-semibold">
              Attributed consolidation adjustments
            </h3>
            <p className="text-sm text-slate-500">
              Ownership and transferred-asset basis are included automatically.
              Identify other disposal-related amounts, including goodwill
              impairment and intercompany eliminations. Use the signed portion
              attributable to this subsidiary, not unrelated lines in the same
              journal.
            </p>
            {adjustments.map((line, i) => (
              <div key={i} className="space-y-2">
                <SearchSelect
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
                  aria-label="Attributed signed amount"
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
                  onClick={() => {
                    setAdjustments((rows) => rows.filter((_, n) => n !== i));
                    changed();
                  }}
                >
                  Remove adjustment
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() => {
                setAdjustments((rows) => [...rows, { lineId: "", amount: "" }]);
                changed();
              }}
            >
              Add adjustment
            </Button>
          </section>
          <section className="space-y-3">
            <h3 className="font-semibold">Other comprehensive income</h3>
            {memo(
              "ociAssessment",
              "Reserve attribution and recycling assessment, including any nil balances",
            )}
            <p className="text-sm text-slate-500">
              Enter the parent-attributable reserve balance in group currency,
              with its ledger sign. Non-controlling interests are derecognized
              separately.
            </p>
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
                    value={line.accountId}
                    onChange={(accountId) => update({ accountId })}
                    options={accountOptions}
                    placeholder="Reserve account"
                  />
                  <Input
                    aria-label="Reserve description"
                    value={line.description}
                    onChange={(e) => update({ description: e.target.value })}
                  />
                  <Input
                    aria-label="Signed reserve balance"
                    value={line.balance}
                    onChange={(e) => update({ balance: e.target.value })}
                  />
                  <Select
                    value={line.treatment}
                    onChange={(e) =>
                      update({ treatment: e.target.value as Oci["treatment"] })
                    }
                  >
                    {[
                      {
                        value: "profit_loss",
                        label: "Reclassify to profit or loss",
                      },
                      {
                        value: "retained_earnings",
                        label: "Transfer directly to retained earnings",
                      },
                    ].map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  <SearchSelect
                    value={line.destinationAccountId}
                    onChange={(destinationAccountId) =>
                      update({ destinationAccountId })
                    }
                    options={accountOptions}
                    placeholder="Destination account"
                  />
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setOci((rows) => rows.filter((_, n) => n !== i));
                      changed();
                    }}
                  >
                    Remove reserve
                  </Button>
                </div>
              );
            })}
            <Button
              variant="outline"
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
              Add reserve
            </Button>
          </section>
        </div>
      </Drawer>
    </>
  );
}
