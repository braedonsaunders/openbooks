"use client";
import { GroupComponentFields } from "./GroupComponentFields";
import type { GroupComponentInput } from "@openbooks/engine/src/assets/group-component.ts";
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
import { useDirtyClose } from "@/lib/use-dirty-close";
import { useTranslations } from "next-intl";
type Option = { value: string; label: string };
type Setup = {
  subsidiaries: {
    id: string;
    name: string;
    base_currency: string;
    is_elimination: boolean;
  }[];
  books: { id: string; name: string }[];
  groupBooks: { book_id: string; group_currency: string }[];
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
  const t = useTranslations("assets.change"),
    tCommon = useTranslations("common");
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
        group?: GroupComponentInput;
      }
    >
  >({});
  const [plans, setPlans] = useState<
    Record<string, { date: string; amount: string }[]>
  >({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [initialKey, setInitialKey] = useState(key);
  const set = (name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    setKey(crypto.randomUUID());
  };
  const closeDrawer = () => {
    setOpen(false);
    setOperation("partial_disposal");
    setMode("percent");
    setValues({ effectiveOn: today, percent: "", proceeds: "", buyerAmount: "", buyerSalvage: "", sellerToGroupRate: "", buyerToGroupRate: "", taxRatePercent: "" });
    setComponents({});
    setPlans({});
    const freshKey = crypto.randomUUID();
    setInitialKey(freshKey);
    setKey(freshKey);
  };
  const closeGuard = useDirtyClose({
    dirty: key !== initialKey, busy, onClose: closeDrawer,
    message: tCommon("feedback.unsavedChanges"), confirmLabel: tCommon("confirm.discardChanges"),
  });
  async function show() {
    setBusy(true);
    try {
      const response = await fetch(`/api/assets/${assetId}/changes`);
      if (!response.ok) {
        const e = await response.json().catch(() => ({}));
        throw new Error(e.error ?? t("loadFailed"));
      }
      setSetup(await response.json());
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("openFailed"));
    } finally {
      setBusy(false);
    }
  }
  const field = (name: string, label: string, type = "text") => (
    <div className="space-y-1.5" key={name}>
      <Label htmlFor={`asset-change-${name}`}>{label}</Label>
      <Input
        id={`asset-change-${name}`}
        disabled={busy}
        type={type}
        value={values[name] ?? ""}
        onChange={(e) => set(name, e.target.value)}
      />
    </div>
  );
  const choice = (name: string, label: string, options: Option[]) => (
    <div className="space-y-1.5" key={name}>
      <Label id={`asset-change-${name}-label`}>{label}</Label>
      <SearchSelect
        disabled={busy}
        value={values[name] ?? ""}
        onChange={(v) => set(name, v)}
        options={options}
        placeholder={t("selectPlaceholder")}
        ariaLabelledBy={`asset-change-${name}-label`}
        ariaLabel={label}
      />
    </div>
  );
  const memo = (name: string, label: string) => (
    <div className="space-y-1.5" key={name}>
      <Label htmlFor={`asset-change-${name}`}>{label}</Label>
      <Textarea
        id={`asset-change-${name}`}
        disabled={busy}
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
        throw new Error(e.error ?? t("submitFailed"));
      }
      const result = (await response.json()) as { changeId: string };
      setOpen(false);
      router.push(`/accounting/changes?change=${result.changeId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("submitFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" onClick={show} disabled={busy}>
        {t("actionName")}
      </Button>
      <Drawer
        stacked
        open={open}
        onClose={closeGuard.close}
        title={t("title")}
        description={t("description")}
        size="2xl"
        footer={
          <Button onClick={submit} disabled={busy}>
            {busy ? t("preparing") : t("prepare")}
          </Button>
        }
      >
        <fieldset disabled={busy} className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="asset-change-operation">{t("changeType")}</Label>
              <Select
                id="asset-change-operation"
                value={operation}
                onChange={(e) => {
                  setOperation(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              >
                <option value="partial_disposal">{t("partialDisposal")}</option>
                <option value="intercompany_transfer">
                  {t("intercompanyTransfer")}
                </option>
              </Select>
            </div>
            {field("effectiveOn", t("effectiveDate"), "date")}
          </div>
          {memo("reason", t("reason"))}
          {memo("assessment", t("assessment"))}
          <div>
            <Label htmlFor="asset-change-mode">{t("measurement")}</Label>
            <Select
              id="asset-change-mode"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setKey(crypto.randomUUID());
              }}
            >
              <option value="percent">{t("percentMode")}</option>
              <option value="component">{t("componentMode")}</option>
            </Select>
          </div>
          {mode === "percent" ? (
            field("percent", t("percentLabel"))
          ) : (
            <div className="space-y-4">
              {setup?.books.map((b) => (
                <fieldset key={b.id} className="space-y-2">
                  <legend>{b.name}</legend>
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        ["cost", t("cost")],
                        ["accumulated", t("accumulated")],
                        ["salvage", t("salvage")],
                        ["remainingProductionUnits", t("remainingUnits")],
                      ] as const
                    ).map(([k, label]) => (
                      <div key={k}>
                        <Label id={`asset-change-component-${k}-label`}>{label}</Label>
                        <Input
                          aria-labelledby={`asset-change-component-${k}-label`}
                          aria-label={label}
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
                  {setup.groupBooks?.find((g) => g.book_id === b.id) ? (
                    <GroupComponentFields
                      value={components[b.id]?.group}
                      currency={
                        setup.groupBooks.find((g) => g.book_id === b.id)!
                          .group_currency
                      }
                      onward={operation === "intercompany_transfer"}
                      onChange={(group) => {
                        setComponents((v) => ({
                          ...v,
                          [b.id]: {
                            cost: "",
                            accumulated: "",
                            salvage: "",
                            ...v[b.id],
                            group,
                          },
                        }));
                        setKey(crypto.randomUUID());
                      }}
                    />
                  ) : null}
                </fieldset>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            {field("proceeds", t("proceeds"))}
            {choice(
              "proceedsAccountId",
              operation === "intercompany_transfer"
                ? t("sellerDueFrom")
                : t("proceedsAccount"),
              accounts,
            )}
          </div>
          {operation === "intercompany_transfer" && setup ? (
            <>
              <h3 className="font-semibold">{t("receivingTitle")}</h3>
              <div className="grid grid-cols-2 gap-4">
                {choice(
                  "subsidiaryId",
                  t("receivingCompany"),
                  setup.subsidiaries
                    .filter((s) => !s.is_elimination)
                    .map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.base_currency})`,
                    })),
                )}
                {choice(
                  "categoryId",
                  t("receivingCategory"),
                  categories.map((c) => ({ value: c.id, label: c.name })),
                )}
                {field("assetNumber", t("receivingNumber"))}
                {field("name", t("receivingName"))}
                {field("buyerAmount", t("buyerAmount"))}
                {field("buyerSalvage", t("buyerSalvage"))}
                {field("buyerProductionUnits", t("buyerUnits"))}
                {field("lifeMonths", t("buyerLife"), "number")}
                {choice("payableAccountId", t("buyerDueTo"), accounts)}
              </div>
              <h3 className="font-semibold">{t("groupTitle")}</h3>
              <div className="grid grid-cols-2 gap-4">
                {choice(
                  "eliminationSubsidiaryId",
                  t("eliminationCompany"),
                  setup.subsidiaries
                    .filter((s) => s.is_elimination)
                    .map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.base_currency})`,
                    })),
                )}
                {field("sellerToGroupRate", t("sellerToGroup"))}
                {field("buyerToGroupRate", t("buyerToGroup"))}
                {field("sellerToBuyerRate", t("sellerToBuyer"))}
                {choice("ctaAccountId", t("ctaAccount"), accounts)}
                {choice("groupAssetAccountId", t("groupAsset"), accounts)}
                {choice(
                  "groupAccumulatedAccountId",
                  t("groupAccumulated"),
                  accounts,
                )}
                {choice(
                  "groupDepreciationAccountId",
                  t("groupDepreciation"),
                  accounts,
                )}
                {choice(
                  "groupGainLossAccountId",
                  t("groupGainLoss"),
                  accounts,
                )}
                {field("taxRatePercent", t("taxRate"))}
                {choice(
                  "deferredTaxAccountId",
                  t("deferredTax"),
                  accounts,
                )}
                {choice(
                  "taxExpenseAccountId",
                  t("taxExpense"),
                  accounts,
                )}
              </div>
              {memo("exchangeRateEvidence", t("fxEvidence"))}
              {memo("groupAssessment", t("groupAssessment"))}
              <details>
                <summary className="cursor-pointer">{t("planTitle")}</summary>
                <p className="py-2 text-sm text-slate-500">{t("planHelp")}</p>
                {setup.books.map((b) => (
                  <fieldset key={b.id} className="mb-4 space-y-2">
                    <legend>{b.name}</legend>
                    {(plans[b.id] ?? []).map((line, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          aria-label={t("planDate")}
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
                          aria-label={t("planAmount")}
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
                          {tCommon("actions.remove")}
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
                      {t("addCharge")}
                    </Button>
                  </fieldset>
                ))}
              </details>
            </>
          ) : null}
        </fieldset>
      </Drawer>
    </>
  );
}
