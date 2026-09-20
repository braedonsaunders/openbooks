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
type Option = { value: string; label: string };
type Setup = {
  subsidiaries: {
    id: string;
    name: string;
    base_currency: string;
    is_elimination: boolean;
  }[];
  books: { id: string; name: string }[];
};
/** Uses the same stacked native Drawer and account pickers as the asset record. */
export function AssetChangeButton({
  assetId,
  accounts,
  categories,
}: {
  assetId: string;
  accounts: Option[];
  categories: { id: string; name: string }[];
}) {
  const router = useRouter(),
    today = useBusinessToday();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [setup, setSetup] = useState<Setup | null>(null);
  const [operation, setOperation] = useState("partial_disposal"),
    [mode, setMode] = useState("percent");
  const [values, setValues] = useState<Record<string, string>>({
    effectiveOn: today,
    percent: "",
    proceeds: "",
    buyerAmount: "",
    buyerSalvage: "",
    sellerToGroupRate: "",
    buyerToGroupRate: "",
    taxRatePercent: "",
  });
  const [components, setComponents] = useState<
    Record<
      string,
      {
        cost: string;
        accumulated: string;
        salvage: string;
        remainingProductionUnits?: string;
      }
    >
  >({});
  const [plans, setPlans] = useState<
    Record<string, { date: string; amount: string }[]>
  >({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const set = (name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    setKey(crypto.randomUUID());
  };
  async function show() {
    setBusy(true);
    try {
      const response = await fetch(`/api/assets/${assetId}/changes`);
      if (!response.ok) {
        const e = await response.json().catch(() => ({}));
        throw new Error(e.error ?? "Unable to load asset change options");
      }
      setSetup(await response.json());
      setOpen(true);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Unable to open asset change",
      );
    } finally {
      setBusy(false);
    }
  }
  const field = (name: string, label: string, type = "text") => (
    <div className="space-y-1.5" key={name}>
      <Label htmlFor={`asset-change-${name}`}>{label}</Label>
      <Input
        id={`asset-change-${name}`}
        type={type}
        value={values[name] ?? ""}
        onChange={(e) => set(name, e.target.value)}
      />
    </div>
  );
  const choice = (name: string, label: string, options: Option[]) => (
    <div className="space-y-1.5" key={name}>
      <Label>{label}</Label>
      <SearchSelect
        value={values[name] ?? ""}
        onChange={(v) => set(name, v)}
        options={options}
        placeholder={`Select ${label.toLowerCase()}`}
      />
    </div>
  );
  const memo = (name: string, label: string) => (
    <div className="space-y-1.5" key={name}>
      <Label htmlFor={`asset-change-${name}`}>{label}</Label>
      <Textarea
        id={`asset-change-${name}`}
        value={values[name] ?? ""}
        onChange={(e) => set(name, e.target.value)}
      />
    </div>
  );
  async function submit() {
    setBusy(true);
    try {
      const body = {
        operation,
        effectiveOn: values.effectiveOn,
        reason: values.reason,
        idempotencyKey: key,
        assessment: values.assessment,
        proceeds: values.proceeds,
        proceedsAccountId: values.proceedsAccountId,
        portion:
          mode === "percent"
            ? { percent: values.percent }
            : {
                books: setup!.books.map((b) => ({
                  bookId: b.id,
                  ...components[b.id],
                  remainingProductionUnits:
                    components[b.id]?.remainingProductionUnits || undefined,
                })),
              },
        ...(operation === "intercompany_transfer"
          ? {
              transfer: {
                ...Object.fromEntries(
                  [
                    "subsidiaryId",
                    "categoryId",
                    "assetNumber",
                    "name",
                    "buyerAmount",
                    "buyerSalvage",
                    "buyerProductionUnits",
                    "payableAccountId",
                    "eliminationSubsidiaryId",
                    "sellerToGroupRate",
                    "buyerToGroupRate",
                    "sellerToBuyerRate",
                    "ctaAccountId",
                    "groupAssetAccountId",
                    "groupAccumulatedAccountId",
                    "groupDepreciationAccountId",
                    "groupGainLossAccountId",
                    "taxRatePercent",
                    "deferredTaxAccountId",
                    "taxExpenseAccountId",
                    "exchangeRateEvidence",
                    "groupAssessment",
                  ].map((k) => [
                    k,
                    k === "buyerProductionUnits" && !values[k]
                      ? undefined
                      : values[k],
                  ]),
                ),
                lifeMonths: Number(values.lifeMonths),
                groupPlans: Object.entries(plans)
                  .filter(([, lines]) => lines.length)
                  .map(([bookId, lines]) => ({ bookId, lines })),
              },
            }
          : {}),
      };
      const response = await fetch(`/api/assets/${assetId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const e = await response.json().catch(() => ({}));
        throw new Error(e.error ?? "Asset change could not be proposed");
      }
      const result = (await response.json()) as { changeId: string };
      setOpen(false);
      router.push(`/accounting/changes?change=${result.changeId}`);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Asset change could not be proposed",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" onClick={show} disabled={busy}>
        Partial disposal / transfer
      </Button>
      <Drawer
        stacked
        open={open}
        onClose={() => setOpen(false)}
        title="Change asset ownership or dispose a component"
        description="Review the book-specific impact, then submit the proposal for independent approval."
        size="2xl"
        footer={
          <Button onClick={submit} disabled={busy}>
            {busy ? "Preparing…" : "Prepare proposal"}
          </Button>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Change type</Label>
              <Select
                value={operation}
                onChange={(e) => {
                  setOperation(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              >
                <option value="partial_disposal">
                  Partial disposal or write-off
                </option>
                <option value="intercompany_transfer">
                  Intercompany asset transfer
                </option>
              </Select>
            </div>
            {field("effectiveOn", "Effective date", "date")}
          </div>
          {memo("reason", "Reason for the change")}
          {memo(
            "assessment",
            "Component identification and carrying-value assessment",
          )}
          <div>
            <Label>Measurement of the disposed portion</Label>
            <Select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setKey(crypto.randomUUID());
              }}
            >
              <option value="percent">Homogeneous physical percentage</option>
              <option value="component">
                Identified component amounts by book
              </option>
            </Select>
          </div>
          {mode === "percent" ? (
            field("percent", "Disposed percentage (100 for the entire asset)")
          ) : (
            <div className="space-y-4">
              {setup?.books.map((b) => (
                <fieldset key={b.id} className="space-y-2">
                  <legend>{b.name}</legend>
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        ["cost", "Cost"],
                        ["accumulated", "Accumulated depreciation"],
                        ["salvage", "Residual value"],
                        [
                          "remainingProductionUnits",
                          "Remaining production units (production method only)",
                        ],
                      ] as const
                    ).map(([k, label]) => (
                      <div key={k}>
                        <Label>{label}</Label>
                        <Input
                          value={components[b.id]?.[k] ?? ""}
                          onChange={(e) => {
                            setComponents((v) => ({
                              ...v,
                              [b.id]: {
                                cost: "",
                                accumulated: "",
                                salvage: "",
                                ...v[b.id],
                                [k]: e.target.value,
                              },
                            }));
                            setKey(crypto.randomUUID());
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            {field(
              "proceeds",
              "Seller proceeds in its functional currency (0 for write-off)",
            )}
            {choice(
              "proceedsAccountId",
              operation === "intercompany_transfer"
                ? "Seller due-from account"
                : "Proceeds account",
              accounts,
            )}
          </div>
          {operation === "intercompany_transfer" && setup ? (
            <>
              <h3 className="font-semibold">Receiving company and asset</h3>
              <div className="grid grid-cols-2 gap-4">
                {choice(
                  "subsidiaryId",
                  "Receiving company",
                  setup.subsidiaries
                    .filter((s) => !s.is_elimination)
                    .map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.base_currency})`,
                    })),
                )}
                {choice(
                  "categoryId",
                  "Receiving category",
                  categories.map((c) => ({ value: c.id, label: c.name })),
                )}
                {field("assetNumber", "Receiving asset number")}
                {field("name", "Receiving asset name")}
                {field("buyerAmount", "Buyer cost in its functional currency")}
                {field("buyerSalvage", "Buyer residual value")}
                {field(
                  "buyerProductionUnits",
                  "Buyer lifetime production units (production method only)",
                )}
                {field("lifeMonths", "Buyer useful life (months)", "number")}
                {choice("payableAccountId", "Buyer due-to account", accounts)}
              </div>
              <h3 className="font-semibold">
                Group basis and internal profit elimination
              </h3>
              <div className="grid grid-cols-2 gap-4">
                {choice(
                  "eliminationSubsidiaryId",
                  "Elimination company",
                  setup.subsidiaries
                    .filter((s) => s.is_elimination)
                    .map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.base_currency})`,
                    })),
                )}
                {field(
                  "sellerToGroupRate",
                  "Seller-to-group historical rate (1 if same currency)",
                )}
                {field(
                  "buyerToGroupRate",
                  "Buyer-to-group historical rate (1 if same currency)",
                )}
                {field(
                  "sellerToBuyerRate",
                  "Seller-to-buyer transaction rate (1 if same currency)",
                )}
                {choice(
                  "ctaAccountId",
                  "Currency translation adjustment account",
                  accounts,
                )}
                {choice("groupAssetAccountId", "Group asset account", accounts)}
                {choice(
                  "groupAccumulatedAccountId",
                  "Group accumulated depreciation",
                  accounts,
                )}
                {choice(
                  "groupDepreciationAccountId",
                  "Group depreciation expense",
                  accounts,
                )}
                {choice(
                  "groupGainLossAccountId",
                  "Group gain/loss account",
                  accounts,
                )}
                {field("taxRatePercent", "Applicable deferred-tax rate (%)")}
                {choice(
                  "deferredTaxAccountId",
                  "Deferred-tax balance account",
                  accounts,
                )}
                {choice(
                  "taxExpenseAccountId",
                  "Deferred-tax expense account",
                  accounts,
                )}
              </div>
              {memo("exchangeRateEvidence", "Exchange-rate evidence")}
              {memo(
                "groupAssessment",
                "Group accounting and deferred-tax assessment (explain a zero rate)",
              )}
              <details>
                <summary className="cursor-pointer">
                  Input-driven group depreciation plan
                </summary>
                <p className="py-2 text-sm text-slate-500">
                  Formula schedules reuse the seller’s remaining plan. For
                  manual or production-based depreciation, provide the approved
                  future group charges in seller currency.
                </p>
                {setup.books.map((b) => (
                  <fieldset key={b.id} className="mb-4 space-y-2">
                    <legend>{b.name}</legend>
                    {(plans[b.id] ?? []).map((line, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          aria-label="Group depreciation date"
                          type="date"
                          value={line.date}
                          onChange={(e) => {
                            setPlans((p) => ({
                              ...p,
                              [b.id]: p[b.id]!.map((l, j) =>
                                j === i ? { ...l, date: e.target.value } : l,
                              ),
                            }));
                            setKey(crypto.randomUUID());
                          }}
                        />
                        <Input
                          aria-label="Group depreciation amount"
                          value={line.amount}
                          onChange={(e) => {
                            setPlans((p) => ({
                              ...p,
                              [b.id]: p[b.id]!.map((l, j) =>
                                j === i ? { ...l, amount: e.target.value } : l,
                              ),
                            }));
                            setKey(crypto.randomUUID());
                          }}
                        />
                        <Button
                          variant="outline"
                          onClick={() => {
                            setPlans((p) => ({
                              ...p,
                              [b.id]: p[b.id]!.filter((_, j) => j !== i),
                            }));
                            setKey(crypto.randomUUID());
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setPlans((p) => ({
                          ...p,
                          [b.id]: [
                            ...(p[b.id] ?? []),
                            { date: "", amount: "" },
                          ],
                        }));
                        setKey(crypto.randomUUID());
                      }}
                    >
                      Add charge
                    </Button>
                  </fieldset>
                ))}
              </details>
            </>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}
