"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ActionError } from "@braedonsaunders/appkit-errors";
import { Button, Input, SearchSelect, Textarea, UrlDrawer } from "@openbooks/ui";
import type { NewRecordData } from "./view";
import { CommandRefusal, Field, SegmentTabs, postCommand, withParams } from "./shared";
import { fetchAppAction } from "@/lib/api-error";
import { partyEmailInvalid } from "@/lib/party-email";
import { useAppAction } from "@/lib/use-app-action";
import { DateField } from "../../../components/date-field";

type Kind = "share" | "option" | "rsu" | "warrant" | "safe" | "note";

const blank = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/**
 * The view's New action opens here (`?new=<record>`): issue a security, or
 * record a share class, a plan, a round or a stakeholder. Each form posts to
 * its native command, which validates against the legal entity's history and
 * posts any cash to the ledger. A new stakeholder is a party; the form then
 * continues to issue the holder's first security.
 */
export function NewRecordDrawer({ data }: { data: NewRecordData | null }) {
  const t = useTranslations("equity");
  const router = useRouter();
  if (!data) return null;
  const done = () => router.push(data.closeHref as never);
  return (
    <UrlDrawer
      open
      openKey={data.kind}
      size="xl"
      closeHref={data.closeHref}
      title={t(`new.actions.${data.kind}`)}
      description={t(`new.descriptions.${data.kind}`)}
    >
      <div className="space-y-4 p-4">
        {data.kind === "security" && <IssueSecurityForm data={data} onDone={done} />}
        {data.kind === "class" && <ShareClassForm data={data} onDone={done} />}
        {data.kind === "plan" && <PlanForm data={data} onDone={done} />}
        {data.kind === "round" && <RoundForm data={data} onDone={done} />}
        {data.kind === "stakeholder" && <StakeholderForm data={data} onDone={done} />}
      </div>
    </UrlDrawer>
  );
}

/**
 * A form's create command through the house action path: a refusal pins
 * beside the form (with the server's remedy) until the next attempt, and a
 * success continues to the next step or closes the drawer.
 */
function useSubmit(onDone: () => void) {
  const t = useTranslations("equity");
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  async function submit<T>(
    url: string,
    body: unknown,
    saved: string,
    next?: (result: T) => string | null,
  ) {
    await execute(() => postCommand<T>(url, body, t("new.failed")), {
      fallbackMessage: t("new.failed"),
      onOk: (result) => {
        toast.success(saved);
        const href = next?.(result);
        if (href) router.push(href as never);
        else {
          onDone();
          router.refresh();
        }
      },
    });
  }
  return { busy, refusal, submit };
}

function Actions({
  busy,
  ready,
  onCancel,
  onSubmit,
  label,
  refusal,
}: {
  busy: boolean;
  ready: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  label: string;
  refusal: ActionError | null;
}) {
  const t = useTranslations("equity");
  return (
    <div className="space-y-3">
      <CommandRefusal refusal={refusal} fallback={t("new.failed")} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("actions.cancel")}
        </Button>
        <Button onClick={onSubmit} disabled={busy || !ready}>
          {label}
        </Button>
      </div>
    </div>
  );
}

function IssueSecurityForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations("equity");
  const { busy, refusal, submit } = useSubmit(onDone);
  const [kind, setKind] = useState<Kind>(data.securityKind ?? "share");
  const [vesting, setVesting] = useState<"none" | "time">("none");
  const [form, setForm] = useState({
    holderPartyId: data.holderPartyId ?? "",
    issueDate: data.context.asOf,
    shareClassId: "",
    planId: "",
    roundId: "",
    quantity: "",
    pricePerShare: "",
    considerationAmount: "",
    considerationAccountId: "",
    securityNumber: "",
    expirationDate: "",
    optionType: "iso",
    safeType: "post_money",
    valuationCap: "",
    discountPercent: "",
    interestRatePercent: "",
    interestBasis: "simple",
    interestDayCount: "actual_365",
    maturityDate: "",
    currency: data.context.currency,
    unvestedRepurchaseBasis: "lower_of_cost_or_fmv",
    vestingStart: data.context.asOf,
    vestingMonths: "48",
    cliffMonths: "12",
    vestingFrequency: "monthly",
    acceleration: "none",
    accelerationPercent: "100",
    sharePrice: "",
    volatilityPercent: "",
    riskFreeRatePercent: "",
    expectedTermYears: "",
    dividendYieldPercent: "0",
    attribution: "straight_line",
    memo: "",
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  // Vesting starts on the issue date unless the operator sets another start.
  const [vestingStartSet, setVestingStartSet] = useState(false);
  const setIssueDate = (value: string) =>
    setForm((current) => ({
      ...current,
      issueDate: value,
      vestingStart: vestingStartSet ? current.vestingStart : value,
    }));
  const setVestingStart = (value: string) => {
    setVestingStartSet(true);
    set("vestingStart")(value);
  };
  const [flags, setFlags] = useState({ mfn: false, earlyExercise: false });
  const shareBased = kind === "share" || kind === "option" || kind === "rsu" || kind === "warrant";
  const convertible = kind === "safe" || kind === "note";
  const award = kind === "option" || kind === "rsu";
  const vests = kind === "share" || award;
  const plans = data.plans.filter(
    (plan) => !form.shareClassId || plan.shareClassId === form.shareClassId,
  );
  const rounds = data.rounds.filter(
    (round) => !form.shareClassId || round.shareClassId === form.shareClassId,
  );
  const roundCurrency =
    (kind === "share" || kind === "warrant") && form.roundId
      ? (data.rounds.find((round) => round.value === form.roundId)?.currency ?? null)
      : null;
  const ready = Boolean(
    form.holderPartyId &&
    form.issueDate &&
    (!shareBased || (form.shareClassId && /^\d+$/.test(form.quantity))) &&
    ((kind !== "option" && kind !== "warrant") || form.pricePerShare) &&
    (!convertible || (form.considerationAmount && form.considerationAccountId)) &&
    (!award ||
      (form.sharePrice &&
        (kind === "rsu" ||
          (form.volatilityPercent && form.riskFreeRatePercent && form.expectedTermYears)))) &&
    (kind !== "note" || form.interestRatePercent),
  );
  function issue() {
    const body: Record<string, unknown> = {
      subsidiaryId: data.context.subsidiaryId,
      kind,
      holderPartyId: form.holderPartyId,
      issueDate: form.issueDate,
      securityNumber: blank(form.securityNumber),
      memo: blank(form.memo),
      idempotencyKey: crypto.randomUUID(),
      currency: roundCurrency ?? form.currency,
    };
    if (shareBased)
      Object.assign(body, { shareClassId: form.shareClassId, quantity: form.quantity });
    if (award && form.planId) body.planId = form.planId;
    if ((kind === "share" || kind === "warrant") && form.roundId) body.roundId = form.roundId;
    if (kind !== "rsu" && !convertible && blank(form.pricePerShare))
      body.pricePerShare = blank(form.pricePerShare);
    if (!award && blank(form.considerationAmount))
      body.considerationAmount = blank(form.considerationAmount);
    if (!award && blank(form.considerationAccountId))
      body.considerationAccountId = blank(form.considerationAccountId);
    if (kind === "option") Object.assign(body, { optionType: form.optionType });
    if (kind === "option" && flags.earlyExercise)
      Object.assign(body, {
        earlyExercise: true,
        unvestedRepurchaseBasis: form.unvestedRepurchaseBasis,
      });
    if (kind === "safe" && flags.mfn) body.mfn = true;
    if ((kind === "option" || kind === "warrant") && blank(form.expirationDate))
      body.expirationDate = blank(form.expirationDate);
    if (kind === "safe") body.safeType = form.safeType;
    if (convertible)
      Object.assign(body, {
        valuationCap: blank(form.valuationCap),
        discountPercent: blank(form.discountPercent),
      });
    if (kind === "note")
      Object.assign(body, {
        interestRatePercent: blank(form.interestRatePercent),
        interestBasis: form.interestBasis,
        interestDayCount: form.interestDayCount,
        maturityDate: blank(form.maturityDate),
      });
    if (vests && vesting === "time") {
      Object.assign(body, {
        vestingStart: form.vestingStart,
        vestingMonths: Number.parseInt(form.vestingMonths, 10),
        cliffMonths: Number.parseInt(form.cliffMonths || "0", 10),
        vestingFrequency: form.vestingFrequency,
        acceleration: form.acceleration,
        accelerationPercent: form.acceleration === "none" ? null : blank(form.accelerationPercent),
      });
    }
    if (award) {
      body.valuation = {
        sharePrice: form.sharePrice,
        attribution: form.attribution,
        ...(kind === "option"
          ? {
              volatilityPercent: form.volatilityPercent,
              riskFreeRatePercent: form.riskFreeRatePercent,
              expectedTermYears: form.expectedTermYears,
              dividendYieldPercent: form.dividendYieldPercent || "0",
            }
          : {}),
      };
    }
    void submit<{ id: string; securityNumber: string }>(
      "/api/equity/securities",
      body,
      t("new.securitySaved"),
      (result) =>
        withParams("/equity", data.context.params, { view: "securities", security: result.id }),
    );
  }
  return (
    <div className="space-y-4">
      <Field label={t("fields.kind")}>
        <SearchSelect
          value={kind}
          options={(["share", "option", "rsu", "warrant", "safe", "note"] as const).map(
            (value) => ({ value, label: t(`kind.${value}`) }),
          )}
          onChange={(value) => setKind((value as Kind | null) ?? "share")}
          ariaLabel={t("fields.kind")}
        />
      </Field>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t(`new.kindHelp.${kind}`)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.holder")}>
          <SearchSelect
            value={form.holderPartyId}
            options={data.holders}
            onChange={(value) => set("holderPartyId")(value ?? "")}
            ariaLabel={t("fields.holder")}
          />
        </Field>
        <Field label={t("fields.issueDate")}>
          <DateField value={form.issueDate} onChange={setIssueDate} />
        </Field>
        {shareBased && (
          <>
            <Field label={t("fields.shareClass")}>
              <SearchSelect
                value={form.shareClassId}
                options={data.classes}
                onChange={(value) => set("shareClassId")(value ?? "")}
                ariaLabel={t("fields.shareClass")}
              />
            </Field>
            <Field label={t("fields.quantity")}>
              <Input
                inputMode="numeric"
                value={form.quantity}
                onChange={(e) => set("quantity")(e.target.value)}
              />
            </Field>
          </>
        )}
        {award && (
          <Field label={t("fields.plan")}>
            <SearchSelect
              value={form.planId}
              options={plans}
              onChange={(value) => set("planId")(value ?? "")}
              ariaLabel={t("fields.plan")}
              clearable
            />
          </Field>
        )}
        {(kind === "share" || kind === "warrant") && (
          <Field label={t("fields.round")}>
            <SearchSelect
              value={form.roundId}
              options={rounds}
              onChange={(value) => set("roundId")(value ?? "")}
              ariaLabel={t("fields.round")}
              clearable
            />
          </Field>
        )}
        {(kind === "share" || kind === "option" || kind === "warrant") && (
          <Field label={kind === "share" ? t("fields.pricePerShare") : t("fields.exercisePrice")}>
            <Input
              inputMode="decimal"
              value={form.pricePerShare}
              onChange={(e) => set("pricePerShare")(e.target.value)}
            />
          </Field>
        )}
        {!award && (
          <>
            <Field
              label={convertible ? t("fields.principal") : t("fields.consideration")}
              hint={kind === "share" ? t("new.considerationHint") : undefined}
            >
              <Input
                inputMode="decimal"
                value={form.considerationAmount}
                onChange={(e) => set("considerationAmount")(e.target.value)}
              />
            </Field>
            <Field label={t("fields.considerationAccount")}>
              <SearchSelect
                value={form.considerationAccountId}
                options={data.considerationAccounts}
                onChange={(value) => set("considerationAccountId")(value ?? "")}
                ariaLabel={t("fields.considerationAccount")}
                clearable
              />
            </Field>
          </>
        )}
        <Field
          label={t("fields.currency")}
          hint={
            roundCurrency
              ? t("new.roundCurrencyHint", { currency: roundCurrency })
              : t("new.currencyHint", { currency: data.context.currency })
          }
        >
          <SearchSelect
            value={roundCurrency ?? form.currency}
            options={data.currencies}
            onChange={(value) => set("currency")(value ?? data.context.currency)}
            ariaLabel={t("fields.currency")}
            disabled={roundCurrency !== null}
          />
        </Field>
        {kind === "option" && (
          <Field label={t("fields.optionType")}>
            <SearchSelect
              value={form.optionType}
              options={[
                { value: "iso", label: t("optionType.iso") },
                { value: "nso", label: t("optionType.nso") },
              ]}
              onChange={(value) => set("optionType")(value ?? "iso")}
              ariaLabel={t("fields.optionType")}
            />
          </Field>
        )}
        {(kind === "option" || kind === "warrant") && (
          <Field label={t("fields.expirationDate")}>
            <DateField
              value={form.expirationDate}
              onChange={(value) => set("expirationDate")(value)}
            />
          </Field>
        )}
        {kind === "safe" && (
          <Field label={t("fields.safeType")}>
            <SearchSelect
              value={form.safeType}
              options={[
                { value: "post_money", label: t("safeType.post_money") },
                { value: "pre_money", label: t("safeType.pre_money") },
              ]}
              onChange={(value) => set("safeType")(value ?? "post_money")}
              ariaLabel={t("fields.safeType")}
            />
          </Field>
        )}
        {kind === "safe" && (
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={flags.mfn}
              onChange={(e) => setFlags({ ...flags, mfn: e.target.checked })}
            />
            {t("new.mfn")}
          </label>
        )}
        {kind === "option" && (
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={flags.earlyExercise}
              onChange={(e) => setFlags({ ...flags, earlyExercise: e.target.checked })}
            />
            {t("new.earlyExercise")}
          </label>
        )}
        {kind === "option" && flags.earlyExercise && (
          <Field label={t("fields.unvestedRepurchaseBasis")}>
            <SearchSelect
              value={form.unvestedRepurchaseBasis}
              options={(["lower_of_cost_or_fmv", "cost"] as const).map((value) => ({
                value,
                label: t(`repurchaseBasis.${value}`),
              }))}
              onChange={(value) => set("unvestedRepurchaseBasis")(value ?? "lower_of_cost_or_fmv")}
              ariaLabel={t("fields.unvestedRepurchaseBasis")}
            />
          </Field>
        )}
        {convertible && (
          <>
            <Field label={t("fields.valuationCap")}>
              <Input
                inputMode="decimal"
                value={form.valuationCap}
                onChange={(e) => set("valuationCap")(e.target.value)}
              />
            </Field>
            <Field label={t("fields.discountPercent")}>
              <Input
                inputMode="decimal"
                value={form.discountPercent}
                onChange={(e) => set("discountPercent")(e.target.value)}
              />
            </Field>
          </>
        )}
        {kind === "note" && (
          <>
            <Field label={t("fields.interestRatePercent")}>
              <Input
                inputMode="decimal"
                value={form.interestRatePercent}
                onChange={(e) => set("interestRatePercent")(e.target.value)}
              />
            </Field>
            <Field label={t("fields.interestBasis")}>
              <SearchSelect
                value={form.interestBasis}
                options={(
                  [
                    "simple",
                    "compound_annual",
                    "compound_semiannual",
                    "compound_quarterly",
                    "compound_monthly",
                  ] as const
                ).map((value) => ({ value, label: t(`interestBasis.${value}`) }))}
                onChange={(value) => set("interestBasis")(value ?? "simple")}
                ariaLabel={t("fields.interestBasis")}
              />
            </Field>
            <Field label={t("fields.interestDayCount")}>
              <SearchSelect
                value={form.interestDayCount}
                options={(["actual_365", "actual_360", "thirty_360", "actual_actual"] as const).map(
                  (value) => ({ value, label: t(`dayCount.${value}`) }),
                )}
                onChange={(value) => set("interestDayCount")(value ?? "actual_365")}
                ariaLabel={t("fields.interestDayCount")}
              />
            </Field>
            <Field label={t("fields.maturityDate")}>
              <DateField
                value={form.maturityDate}
                onChange={(value) => set("maturityDate")(value)}
              />
            </Field>
          </>
        )}
        <Field label={t("fields.securityNumber")} hint={t("new.numberHint")}>
          <Input
            value={form.securityNumber}
            onChange={(e) => set("securityNumber")(e.target.value)}
          />
        </Field>
      </div>
      {vests && (
        <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <SegmentTabs
            value={vesting}
            onChange={setVesting}
            label={t("new.vesting")}
            tabs={[
              { key: "none", label: t("new.vestingNone") },
              { key: "time", label: t("new.vestingTime") },
            ]}
          />
          {vesting === "time" && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label={t("fields.vestingStart")}>
                <DateField value={form.vestingStart} onChange={setVestingStart} />
              </Field>
              <Field label={t("fields.vestingMonths")}>
                <Input
                  inputMode="numeric"
                  value={form.vestingMonths}
                  onChange={(e) => set("vestingMonths")(e.target.value)}
                />
              </Field>
              <Field label={t("fields.cliffMonths")}>
                <Input
                  inputMode="numeric"
                  value={form.cliffMonths}
                  onChange={(e) => set("cliffMonths")(e.target.value)}
                />
              </Field>
              <Field label={t("fields.vestingFrequency")}>
                <SearchSelect
                  value={form.vestingFrequency}
                  options={(["monthly", "quarterly", "annual"] as const).map((value) => ({
                    value,
                    label: t(`frequency.${value}`),
                  }))}
                  onChange={(value) => set("vestingFrequency")(value ?? "monthly")}
                  ariaLabel={t("fields.vestingFrequency")}
                />
              </Field>
              <Field label={t("fields.acceleration")}>
                <SearchSelect
                  value={form.acceleration}
                  options={(["none", "single", "double"] as const).map((value) => ({
                    value,
                    label: t(`acceleration.${value}`),
                  }))}
                  onChange={(value) => set("acceleration")(value ?? "none")}
                  ariaLabel={t("fields.acceleration")}
                />
              </Field>
              {form.acceleration !== "none" && (
                <Field label={t("fields.accelerationPercent")}>
                  <Input
                    inputMode="decimal"
                    value={form.accelerationPercent}
                    onChange={(e) => set("accelerationPercent")(e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}
        </section>
      )}
      {award && (
        <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold">{t("new.valuation")}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {kind === "option" ? t("new.valuationOption") : t("new.valuationRsu")}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label={t("fields.grantSharePrice")}>
              <Input
                inputMode="decimal"
                value={form.sharePrice}
                onChange={(e) => set("sharePrice")(e.target.value)}
              />
            </Field>
            {kind === "option" && (
              <>
                <Field label={t("fields.volatilityPercent")}>
                  <Input
                    inputMode="decimal"
                    value={form.volatilityPercent}
                    onChange={(e) => set("volatilityPercent")(e.target.value)}
                  />
                </Field>
                <Field label={t("fields.riskFreeRatePercent")}>
                  <Input
                    inputMode="decimal"
                    value={form.riskFreeRatePercent}
                    onChange={(e) => set("riskFreeRatePercent")(e.target.value)}
                  />
                </Field>
                <Field label={t("fields.expectedTermYears")}>
                  <Input
                    inputMode="decimal"
                    value={form.expectedTermYears}
                    onChange={(e) => set("expectedTermYears")(e.target.value)}
                  />
                </Field>
                <Field label={t("fields.dividendYieldPercent")}>
                  <Input
                    inputMode="decimal"
                    value={form.dividendYieldPercent}
                    onChange={(e) => set("dividendYieldPercent")(e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label={t("fields.attribution")}>
              <SearchSelect
                value={form.attribution}
                options={[
                  { value: "straight_line", label: t("attribution.straight_line") },
                  { value: "graded", label: t("attribution.graded") },
                ]}
                onChange={(value) => set("attribution")(value ?? "straight_line")}
                ariaLabel={t("fields.attribution")}
              />
            </Field>
          </div>
        </section>
      )}
      <Field label={t("fields.memo")}>
        <Textarea rows={2} value={form.memo} onChange={(e) => set("memo")(e.target.value)} />
      </Field>
      <Actions
        refusal={refusal}
        busy={busy}
        ready={ready}
        onCancel={onDone}
        onSubmit={issue}
        label={t("new.issue")}
      />
    </div>
  );
}

function ShareClassForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations("equity");
  const { busy, refusal, submit } = useSubmit(onDone);
  const [form, setForm] = useState({
    code: "",
    name: "",
    kind: "common",
    effectiveOn: data.context.asOf,
    authorizedShares: "",
    parValue: "0.0001",
    originalIssuePrice: "",
    conversionPrice: "",
    liquidationMultiple: "1",
    participation: "none",
    participationCapMultiple: "",
    seniority: "0",
    antiDilution: "none",
    conversionShareClassId: data.commonClasses[0]?.value ?? "",
    liquidationPreferenceBasis: "amount_paid",
  });
  const [adjustsForSplits, setAdjustsForSplits] = useState(true);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const preferred = form.kind === "preferred";
  const ready = Boolean(
    form.code &&
    form.name &&
    form.effectiveOn &&
    /^\d+$/.test(form.authorizedShares) &&
    form.parValue &&
    (!preferred || (form.originalIssuePrice && form.conversionShareClassId)),
  );
  function create() {
    void submit(
      "/api/equity/classes",
      {
        subsidiaryId: data.context.subsidiaryId,
        code: form.code,
        name: form.name,
        kind: form.kind,
        effectiveOn: form.effectiveOn,
        authorizedShares: form.authorizedShares,
        parValue: form.parValue,
        ...(preferred
          ? {
              originalIssuePrice: form.originalIssuePrice,
              conversionPrice: blank(form.conversionPrice),
              liquidationMultiple: blank(form.liquidationMultiple),
              liquidationPreferenceBasis: form.liquidationPreferenceBasis,
              participation: form.participation,
              participationCapMultiple:
                form.participation === "capped" ? blank(form.participationCapMultiple) : null,
              seniority: Number.parseInt(form.seniority || "0", 10),
              antiDilution: form.antiDilution,
              conversionShareClassId: form.conversionShareClassId,
              conversionAdjustsForSplits: adjustsForSplits,
            }
          : {}),
      },
      t("new.classSaved"),
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.code")}>
          <Input value={form.code} onChange={(e) => set("code")(e.target.value)} placeholder="CS" />
        </Field>
        <Field label={t("fields.name")}>
          <Input value={form.name} onChange={(e) => set("name")(e.target.value)} />
        </Field>
        <Field label={t("fields.classKind")}>
          <SearchSelect
            value={form.kind}
            options={[
              { value: "common", label: t("classKind.common") },
              { value: "preferred", label: t("classKind.preferred") },
            ]}
            onChange={(value) => set("kind")(value ?? "common")}
            ariaLabel={t("fields.classKind")}
          />
        </Field>
        <Field label={t("fields.effectiveOn")}>
          <DateField value={form.effectiveOn} onChange={(value) => set("effectiveOn")(value)} />
        </Field>
        <Field label={t("fields.authorizedShares")}>
          <Input
            inputMode="numeric"
            value={form.authorizedShares}
            onChange={(e) => set("authorizedShares")(e.target.value)}
          />
        </Field>
        <Field label={t("fields.parValue")}>
          <Input
            inputMode="decimal"
            value={form.parValue}
            onChange={(e) => set("parValue")(e.target.value)}
          />
        </Field>
        {preferred && (
          <>
            <Field label={t("fields.originalIssuePrice")}>
              <Input
                inputMode="decimal"
                value={form.originalIssuePrice}
                onChange={(e) => set("originalIssuePrice")(e.target.value)}
              />
            </Field>
            <Field label={t("fields.conversionPrice")} hint={t("new.conversionPriceHint")}>
              <Input
                inputMode="decimal"
                value={form.conversionPrice}
                onChange={(e) => set("conversionPrice")(e.target.value)}
              />
            </Field>
            <Field label={t("fields.liquidationMultiple")}>
              <Input
                inputMode="decimal"
                value={form.liquidationMultiple}
                onChange={(e) => set("liquidationMultiple")(e.target.value)}
              />
            </Field>
            <Field
              label={t("fields.liquidationPreferenceBasis")}
              hint={t(
                `preferenceBasisHint.${form.liquidationPreferenceBasis as "amount_paid" | "original_issue_price"}`,
              )}
            >
              <SearchSelect
                value={form.liquidationPreferenceBasis}
                options={(["amount_paid", "original_issue_price"] as const).map((value) => ({
                  value,
                  label: t(`preferenceBasis.${value}`),
                }))}
                onChange={(value) => set("liquidationPreferenceBasis")(value ?? "amount_paid")}
                ariaLabel={t("fields.liquidationPreferenceBasis")}
              />
            </Field>
            <Field label={t("fields.seniority")} hint={t("new.seniorityHint")}>
              <Input
                inputMode="numeric"
                value={form.seniority}
                onChange={(e) => set("seniority")(e.target.value)}
              />
            </Field>
            <Field label={t("fields.participation")}>
              <SearchSelect
                value={form.participation}
                options={(["none", "full", "capped"] as const).map((value) => ({
                  value,
                  label: t(`participation.${value}`),
                }))}
                onChange={(value) => set("participation")(value ?? "none")}
                ariaLabel={t("fields.participation")}
              />
            </Field>
            {form.participation === "capped" && (
              <Field label={t("fields.participationCapMultiple")}>
                <Input
                  inputMode="decimal"
                  value={form.participationCapMultiple}
                  onChange={(e) => set("participationCapMultiple")(e.target.value)}
                />
              </Field>
            )}
            <Field label={t("fields.antiDilution")}>
              <SearchSelect
                value={form.antiDilution}
                options={(["none", "broad_based", "narrow_based", "full_ratchet"] as const).map(
                  (value) => ({ value, label: t(`antiDilution.${value}`) }),
                )}
                onChange={(value) => set("antiDilution")(value ?? "none")}
                ariaLabel={t("fields.antiDilution")}
              />
            </Field>
            <Field
              label={t("fields.conversionClass")}
              hint={data.commonClasses.length === 0 ? t("new.conversionClassMissing") : undefined}
            >
              <SearchSelect
                value={form.conversionShareClassId}
                options={data.commonClasses}
                onChange={(value) => set("conversionShareClassId")(value ?? "")}
                ariaLabel={t("fields.conversionClass")}
              />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={adjustsForSplits}
                onChange={(e) => setAdjustsForSplits(e.target.checked)}
              />
              {t("new.adjustsForSplits")}
            </label>
          </>
        )}
      </div>
      <Actions
        refusal={refusal}
        busy={busy}
        ready={ready}
        onCancel={onDone}
        onSubmit={create}
        label={t("new.createClass")}
      />
    </div>
  );
}

function PlanForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations("equity");
  const { busy, refusal, submit } = useSubmit(onDone);
  const [form, setForm] = useState({
    code: "",
    name: "",
    shareClassId: "",
    effectiveOn: data.context.asOf,
    reservedShares: "",
    recycleForfeited: true,
    recycleExpired: true,
    recycleRepurchased: false,
  });
  const ready = Boolean(
    form.code &&
    form.name &&
    form.shareClassId &&
    form.effectiveOn &&
    /^\d+$/.test(form.reservedShares),
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.code")}>
          <Input
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            placeholder="EIP"
          />
        </Field>
        <Field label={t("fields.name")}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t("fields.shareClass")}>
          <SearchSelect
            value={form.shareClassId}
            options={data.classes}
            onChange={(value) => setForm({ ...form, shareClassId: value ?? "" })}
            ariaLabel={t("fields.shareClass")}
          />
        </Field>
        <Field label={t("fields.effectiveOn")}>
          <DateField
            value={form.effectiveOn}
            onChange={(value) => setForm({ ...form, effectiveOn: value })}
          />
        </Field>
        <Field label={t("fields.reservedShares")}>
          <Input
            inputMode="numeric"
            value={form.reservedShares}
            onChange={(e) => setForm({ ...form, reservedShares: e.target.value })}
          />
        </Field>
      </div>
      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">{t("new.recycling")}</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.recycleForfeited}
            onChange={(e) => setForm({ ...form, recycleForfeited: e.target.checked })}
          />
          {t("plans.recycle.forfeited")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.recycleExpired}
            onChange={(e) => setForm({ ...form, recycleExpired: e.target.checked })}
          />
          {t("plans.recycle.expired")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.recycleRepurchased}
            onChange={(e) => setForm({ ...form, recycleRepurchased: e.target.checked })}
          />
          {t("plans.recycle.repurchased")}
        </label>
      </fieldset>
      <Actions
        refusal={refusal}
        busy={busy}
        ready={ready}
        onCancel={onDone}
        onSubmit={() =>
          void submit(
            "/api/equity/plans",
            { subsidiaryId: data.context.subsidiaryId, ...form },
            t("new.planSaved"),
          )
        }
        label={t("new.createPlan")}
      />
    </div>
  );
}

function RoundForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations("equity");
  const { busy, refusal, submit } = useSubmit(onDone);
  const [form, setForm] = useState({
    name: "",
    shareClassId: "",
    closedOn: data.context.asOf,
    pricePerShare: "",
    preMoneyValuation: "",
    currency: data.context.currency,
    preMoneyBasisReason: "",
  });
  const ready = Boolean(
    form.name && form.shareClassId && form.closedOn && form.pricePerShare && form.preMoneyValuation,
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t("new.roundHelp")}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.name")}>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Series A"
          />
        </Field>
        <Field label={t("fields.shareClass")}>
          <SearchSelect
            value={form.shareClassId}
            options={data.classes}
            onChange={(value) => setForm({ ...form, shareClassId: value ?? "" })}
            ariaLabel={t("fields.shareClass")}
          />
        </Field>
        <Field label={t("fields.closedOn")}>
          <DateField
            value={form.closedOn}
            onChange={(value) => setForm({ ...form, closedOn: value })}
          />
        </Field>
        <Field label={t("fields.pricePerShare")}>
          <Input
            inputMode="decimal"
            value={form.pricePerShare}
            onChange={(e) => setForm({ ...form, pricePerShare: e.target.value })}
          />
        </Field>
        <Field label={t("fields.preMoneyValuation")}>
          <Input
            inputMode="decimal"
            value={form.preMoneyValuation}
            onChange={(e) => setForm({ ...form, preMoneyValuation: e.target.value })}
          />
        </Field>
        <Field
          label={t("fields.currency")}
          hint={t("new.currencyHint", { currency: data.context.currency })}
        >
          <SearchSelect
            value={form.currency}
            options={data.currencies}
            onChange={(value) => setForm({ ...form, currency: value ?? data.context.currency })}
            ariaLabel={t("fields.currency")}
          />
        </Field>
      </div>
      <Field label={t("fields.preMoneyBasisReason")} hint={t("new.preMoneyBasisHint")}>
        <Textarea
          rows={2}
          value={form.preMoneyBasisReason}
          onChange={(e) => setForm({ ...form, preMoneyBasisReason: e.target.value })}
        />
      </Field>
      <Actions
        refusal={refusal}
        busy={busy}
        ready={ready}
        onCancel={onDone}
        onSubmit={() =>
          void submit(
            "/api/equity/rounds",
            {
              subsidiaryId: data.context.subsidiaryId,
              ...form,
              preMoneyBasisReason: form.preMoneyBasisReason.trim() || null,
            },
            t("new.roundSaved"),
          )
        }
        label={t("new.createRound")}
      />
    </div>
  );
}

/**
 * A stakeholder is a party: a person or a company. Saving creates the party
 * and continues to issue the holder's first security, which puts them on the
 * cap table.
 */
function StakeholderForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations("equity");
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  const [form, setForm] = useState({ kind: "person", displayName: "", email: "" });
  // The party route refuses an address no message could be sent to; the form
  // says so as it is typed rather than after a round trip.
  const emailInvalid = partyEmailInvalid(form.email);
  const ready = form.displayName.trim().length > 0 && !emailInvalid;
  async function create() {
    // The idempotency key becomes the party's id, so a retry of the same
    // request returns the same stakeholder.
    const id = crypto.randomUUID();
    await execute(
      () =>
        fetchAppAction(
          "/api/parties",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": id },
            body: JSON.stringify({
              kind: form.kind,
              displayName: form.displayName.trim(),
              email: blank(form.email),
            }),
          },
          { fallback: t("new.failed") },
        ),
      {
        fallbackMessage: t("new.failed"),
        onOk: () => {
          toast.success(t("new.stakeholderSaved", { name: form.displayName.trim() }));
          router.push(
            withParams("/equity", data.context.params, { new: "security", newHolder: id }) as never,
          );
        },
      },
    );
  }
  const emailError: ReactNode = emailInvalid ? (
    <span className="text-red-700 dark:text-red-300">{t("new.emailInvalid")}</span>
  ) : null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t("new.stakeholderHelp")}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.partyKind")}>
          <SearchSelect
            value={form.kind}
            options={[
              { value: "person", label: t("partyKind.person") },
              { value: "company", label: t("partyKind.company") },
            ]}
            onChange={(value) => setForm({ ...form, kind: value ?? "person" })}
            ariaLabel={t("fields.partyKind")}
          />
        </Field>
        <Field label={t("fields.name")}>
          <Input
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </Field>
        <div className="space-y-1">
          <Field label={t("stakeholders.columns.email")}>
            <Input
              type="email"
              value={form.email}
              aria-invalid={emailInvalid}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          {emailError && (
            <p className="text-xs" role="alert">
              {emailError}
            </p>
          )}
        </div>
      </div>
      <Actions
        refusal={refusal}
        busy={busy}
        ready={ready}
        onCancel={onDone}
        onSubmit={() => void create()}
        label={t("new.createStakeholder")}
      />
    </div>
  );
}
