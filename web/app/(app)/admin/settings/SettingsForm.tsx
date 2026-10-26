"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
  SearchSelect,
  Select,
  type SelectOption,
} from "@openbooks/ui";
import { LOCALES, isLocale, type Locale } from "../../../../i18n/config";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { SaasMetricsNormalization } from "./SaasMetricsNormalization";
import type { ControlAccountRole } from "@openbooks/engine/records/control-accounts";
import { countryOptions } from "../../../../lib/countries";
import { accountTypeMessageKey, controlAccountPickerOptions } from "./control-account-options";
import {
  EMPTY_ADDRESS,
  LegalIdentityCard,
  legalIdentityPayload,
  type LegalIdentityValue,
} from "./LegalIdentityCard";

export type AccountOption = { id: string; label: string; type: string };

type Initial = {
  name: string;
  legalName: string;
  country: string;
  baseCurrency: string;
  /** Effective business time zone (canonical IANA name, UTC when unset). */
  timeZone: string;
  fiscalYearStartMonth: number;
  reportingFramework: "us_gaap" | "ifrs";
  taxFramework?: "asc740" | "ias12";
  defaultLocale: Locale;
  reportPdfStyle: "formal" | "modern";
  fairValueRangePolicy: "warn" | "off";
  contractCreation: "first_billing" | "booking";
  saasMetrics?: {
    evergreenBookingMonths: string;
    billingsUsePreTaxSubtotal: boolean;
    customerCreditsReduceBillings: boolean;
  };
  controlAccounts: Partial<Record<ControlAccountRole, string>>;
  /** Journal/deposit lines on a receivable or payable account with no
   *  customer or vendor: post with a warning, or refuse at posting. */
  partylessControlPolicy?: "warn" | "refuse";
  cashSales?: {
    walkInCustomerId: string;
    defaultCashAccountId: string;
    defaultCardAccountId: string;
    defaultBankAccountId: string;
    depositAccountIds: string[];
  };
  /** Company default payment terms invoices and bills fall back to. */
  billing?: {
    defaultPaymentTermsId: string;
  };
  /** Registered address, legal form, tax classification and identifiers. */
  legalIdentity?: LegalIdentityValue;
};

const EMPTY_LEGAL_IDENTITY: LegalIdentityValue = {
  address: EMPTY_ADDRESS,
  legalForm: "",
  taxClassification: "",
  taxIds: {},
};

/** Blank till defaults: no walk-in customer, no account prefills, no drop destinations. */
const EMPTY_CASH_SALES = {
  walkInCustomerId: "",
  defaultCashAccountId: "",
  defaultCardAccountId: "",
  defaultBankAccountId: "",
  depositAccountIds: [] as string[],
};

// Month message keys under admin.settings.months, indexed 0–11.
const MONTH_KEYS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

export function SettingsForm({
  initial,
  accounts,
  controlAccountRoles,
  controlAccountPolicy,
  currencies,
  timeZones,
  multiSubsidiary = false,
  revenueRecognition = false,
  revenueContracts = false,
  saasMetricsEnabled = false,
  cashSalesEnabled = false,
  customers = [],
  paymentTerms = [],
}: {
  initial: Initial;
  accounts: AccountOption[];
  controlAccountRoles: readonly ControlAccountRole[];
  /** Accepted chart account types per role — the engine's
   *  CONTROL_ACCOUNT_TYPE_POLICY, handed over by the server loader so each
   *  picker offers only accounts the save would accept. */
  controlAccountPolicy: Readonly<Partial<Record<ControlAccountRole, readonly string[]>>>;
  currencies: { code: string; name: string }[];
  /** Canonical IANA zone names the business-time-zone picker offers. */
  timeZones: string[];
  /** When the org runs multiple legal entities, identity/currency are per
   *  subsidiary and control accounts here are the fallback defaults. */
  multiSubsidiary?: boolean;
  /** Company Settings → Features. The fair-value range policy is Revenue
   *  Recognition configuration; hide and omit it when that switch is off. */
  revenueRecognition?: boolean;
  /** Scoped revenue contracts (one contract across several invoices). The
   *  contract-creation choice belongs to it and stays stored while off. */
  revenueContracts?: boolean;
  /** SaaS metrics definitions belong to the gated feature and stay stored when it is disabled. */
  saasMetricsEnabled?: boolean;
  /** Cash-sale till defaults belong to the gated feature and stay stored when it is disabled. */
  cashSalesEnabled?: boolean;
  /** Active customers for the walk-in default picker. */
  customers?: { id: string; label: string }[];
  /** Active payment terms for the company default-terms picker. */
  paymentTerms?: { id: string; label: string }[];
  /** Whether an enabled vendor-bill approval flow exists. The loader always
   *  resolves this; when false the Approvals card warns that bills release
   *  with no approver (or that submits will be refused once required). */
}) {
  const t = useTranslations("admin.settings");
  const tCommon = useTranslations("common");
  const tAccounts = useTranslations("accounts");
  const locale = useLocale();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    ...initial,
    saasMetrics: initial.saasMetrics ?? {
      evergreenBookingMonths: "12",
      billingsUsePreTaxSubtotal: true,
      customerCreditsReduceBillings: true,
    },
    cashSales: { ...EMPTY_CASH_SALES, ...(initial.cashSales ?? {}) },
    billing: { defaultPaymentTermsId: initial.billing?.defaultPaymentTermsId ?? "" },
    legalIdentity: initial.legalIdentity ?? EMPTY_LEGAL_IDENTITY,
  });
  // Identifiers already on file: one recorded under another jurisdiction
  // stays visible (and travels unchanged) until an operator clears it.
  const storedTaxIds = initial.legalIdentity?.taxIds ?? {};
  const [invalidTaxId, setInvalidTaxId] = useState<string | null>(null);
  // Save-attempt marker: the required error shows once a save is attempted
  // with a blank name and clears as soon as typing resumes
  // (a toast alone leaves the field looking saved-but-blank until reload).
  const [showNameError, setShowNameError] = useState(false);
  const nameInvalid = showNameError && !form.name.trim();

  const monthLabel = (m: number) => t(`months.${MONTH_KEYS[(m - 1 + 12) % 12]}`);
  /** "January → December" label for a fiscal year starting in `startMonth`. */
  const fiscalRangeLabel = (startMonth: number) =>
    t("fiscal.range", {
      start: monthLabel(startMonth),
      end: monthLabel(((startMonth + 10) % 12) + 1),
    });

  /** "Equity" / "Other Current Assets or Other Current Liabilities", localized. */
  const expectedTypesLabel = (types: readonly string[]) => {
    const names = types.map((type) => tAccounts(`types.${accountTypeMessageKey(type)}`));
    return new Intl.ListFormat(locale, { type: "disjunction" }).format(names);
  };

  /** A legal-identity refusal, restated in the operator's language. */
  const legalIdentityRefusal = (data: Record<string, unknown>): string | null => {
    if (data.code === "invalid-tax-id" && typeof data.scheme === "string") {
      return t("legalIdentity.refusals.taxId", { label: t(`legalIdentity.taxIds.${data.scheme}`) });
    }
    if (data.code === "invalid-company-address") return t("legalIdentity.refusals.address");
    if (data.code === "tax-classification-mismatch")
      return t("legalIdentity.refusals.classification");
    return null;
  };

  /** A save refusal that names one control-account role is restated with the
   *  field's own label and its accepted types in the operator's language. */
  const controlAccountRefusal = (data: Record<string, unknown>): string | null => {
    const role = data.role;
    if (data.code !== "control-account-invalid" || typeof role !== "string") return null;
    if (!controlAccountRoles.some((known) => known === role)) return null;
    const label = t(`controlAccounts.fields.${role as ControlAccountRole}.label`);
    if (data.reason === "type") {
      const allowed = Array.isArray(data.allowedTypes)
        ? data.allowedTypes.filter((type): type is string => typeof type === "string")
        : (controlAccountPolicy[role as ControlAccountRole] ?? []);
      const actual =
        typeof data.accountType === "string"
          ? tAccounts(`types.${accountTypeMessageKey(data.accountType)}`)
          : "";
      return t("controlAccounts.refusals.type", {
        role: label,
        types: expectedTypesLabel(allowed),
        actual,
      });
    }
    if (data.reason === "inactive") return t("controlAccounts.refusals.inactive", { role: label });
    if (data.reason === "summary") return t("controlAccounts.refusals.summary", { role: label });
    return t("controlAccounts.refusals.missing", { role: label });
  };

  // Till settlement accounts: bank and asset-clearing only — tenders never
  // settle into receivables, payables, or income directly.
  const settlementAccountOptions: SelectOption[] = useMemo(
    () =>
      accounts
        .filter((a) => a.type === "asset_bank" || a.type === "asset_current_other")
        .map((a) => ({ value: a.id, label: a.label })),
    [accounts],
  );

  const timeZoneOptions: SelectOption[] = useMemo(
    () => timeZones.map((zone) => ({ value: zone, label: zone })),
    [timeZones],
  );

  const startMonthChanged = form.fiscalYearStartMonth !== initial.fiscalYearStartMonth;

  function setControl(key: ControlAccountRole, value: string) {
    setForm((f) => ({ ...f, controlAccounts: { ...f.controlAccounts, [key]: value } }));
  }

  async function save() {
    if (!form.name.trim()) {
      setShowNameError(true);
      toast.error(t("validation.nameRequired"));
      return;
    }
    setShowNameError(false);
    if (!form.country.trim()) {
      toast.error(t("validation.countryRequired"));
      return;
    }
    const {
      fairValueRangePolicy,
      contractCreation,
      saasMetrics,
      cashSales,
      billing,
      legalIdentity,
      ...rest
    } = form;
    const identity = legalIdentityPayload(legalIdentity, form.country, storedTaxIds);
    if (!identity.ok) {
      setInvalidTaxId(identity.invalidScheme);
      toast.error(
        t("legalIdentity.taxIdInvalidToast", {
          label: t(`legalIdentity.taxIds.${identity.invalidScheme}`),
        }),
      );
      return;
    }
    setInvalidTaxId(null);
    setSaving(true);
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // The vendor-bill approval requirement is a plain org boolean with no
      // feature fence — it always travels. The fair-value policy stays gated
      // on Revenue Recognition above, contract creation on scoped revenue
      // contracts, and the till defaults on Cash Sales; any of them off omits
      // its field so the stored choice survives.
      body: JSON.stringify({
        ...rest,
        ...identity.payload,
        ...(revenueRecognition ? { fairValueRangePolicy } : {}),
        ...(revenueContracts ? { contractCreation } : {}),
        ...(saasMetricsEnabled ? { saasMetrics } : {}),
        ...(cashSalesEnabled ? { cashSales } : {}),
        // The company default payment terms are core billing configuration
        // with no feature fence — they always travel, blank clearing them.
        billing: { defaultPaymentTermsId: billing.defaultPaymentTermsId || null },
      }),
    });
    setSaving(false);
    if (!res.ok) {
      // The domain mappers need the parsed body while the final fallback
      // reads through the shared helper, so the body parses from a clone
      // and message, remedy and code render instead of a bare fallback.
      const data = (await res
        .clone()
        .json()
        .catch(() => ({}))) as Record<string, unknown>;
      if (data.code === "invalid-tax-id" && typeof data.scheme === "string")
        setInvalidTaxId(data.scheme);
      toast.error(
        controlAccountRefusal(data) ??
          legalIdentityRefusal(data) ??
          (await readApiErrorMessage(res, tCommon("feedback.saveFailed"))),
      );
      return;
    }
    const data = (await res.json()) as { changed?: boolean; periodsRederived?: boolean };
    if (data.changed === false) {
      toast(tCommon("feedback.noChanges"));
      return;
    }
    toast.success(data.periodsRederived ? t("savedPeriodsRederived") : t("saved"));
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Organization identity */}
      <Card>
        <CardHeader>
          <CardTitle>{t("organization.title")}</CardTitle>
          <CardDescription>{t("organization.description")}</CardDescription>
        </CardHeader>
        {multiSubsidiary ? (
          <CardContent className="pt-0">
            <Alert>
              <AlertDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span>{t("organization.perEntityNote")}</span>
                <Link
                  href="/admin/setup/subsidiaries"
                  className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                >
                  {t("organization.subsidiariesLink")}
                </Link>
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : null}
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="name" help={t("organization.displayNameHint")}>
              {t("organization.displayName")}
            </FieldLabel>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t("organization.displayNamePlaceholder")}
              required
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? "name-error" : undefined}
            />
            {nameInvalid ? (
              <p id="name-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
                {t("validation.nameRequired")}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="legalName" help={t("organization.legalNameHint")}>
              {t("organization.legalName")}
            </FieldLabel>
            <Input
              id="legalName"
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              placeholder={t("organization.legalNamePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="country" help={t("organization.countryHint")}>
              {t("organization.country")}
            </FieldLabel>
            <SearchSelect
              ariaLabel={t("organization.country")}
              value={form.country}
              onChange={(value) => setForm((f) => ({ ...f, country: (value ?? "").toUpperCase() }))}
              options={countries}
              placeholder={t("organization.countryPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="defaultLocale" help={t("organization.defaultLanguageHint")}>
              {t("organization.defaultLanguage")}
            </FieldLabel>
            <Select
              id="defaultLocale"
              value={form.defaultLocale}
              onChange={(e) =>
                setForm((f) =>
                  isLocale(e.target.value) ? { ...f, defaultLocale: e.target.value } : f,
                )
              }
            >
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="reportPdfStyle" help={t("organization.reportPdfStyleHint")}>
              {t("organization.reportPdfStyle")}
            </FieldLabel>
            <Select
              id="reportPdfStyle"
              value={form.reportPdfStyle}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  reportPdfStyle: e.target.value === "formal" ? "formal" : "modern",
                }))
              }
            >
              <option value="modern">{t("organization.reportPdfStyleModern")}</option>
              <option value="formal">{t("organization.reportPdfStyleFormal")}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="baseCurrency" help={t("organization.baseCurrencyHint")}>
              {t("organization.baseCurrency")}
            </FieldLabel>
            <Select
              id="baseCurrency"
              value={form.baseCurrency}
              onChange={(e) => setForm((f) => ({ ...f, baseCurrency: e.target.value }))}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="timeZone" help={t("organization.timeZoneHint")}>
              {t("organization.timeZone")}
            </FieldLabel>
            <SearchSelect
              id="timeZone"
              value={form.timeZone}
              onChange={(value) => setForm((f) => ({ ...f, timeZone: value ?? f.timeZone }))}
              options={timeZoneOptions}
              placeholder={t("organization.timeZonePlaceholder")}
              sheetTitle={t("organization.timeZone")}
              ariaLabel={t("organization.timeZone")}
            />
          </div>
        </CardContent>
      </Card>

      <LegalIdentityCard
        value={form.legalIdentity}
        onChange={(legalIdentity) => {
          setInvalidTaxId(null);
          setForm((f) => ({ ...f, legalIdentity }));
        }}
        country={form.country}
        storedTaxIds={storedTaxIds}
        invalidScheme={invalidTaxId}
      />

      {/* Fiscal year — the headline setting */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock size={17} className="text-teal-600 dark:text-teal-300" />
            {t("fiscal.title")}
          </CardTitle>
          <CardDescription>{t("fiscal.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="fiscalStart" help={t("fiscal.description")}>
                {t("fiscal.startsIn")}
              </FieldLabel>
              <Select
                id="fiscalStart"
                value={String(form.fiscalYearStartMonth)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, fiscalYearStartMonth: Number(e.target.value) }))
                }
              >
                {MONTH_KEYS.map((m, i) => (
                  <option key={m} value={String(i + 1)}>
                    {t(`months.${m}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <FieldLabel help={t("fiscal.description")}>{t("fiscal.runs")}</FieldLabel>
              <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                {fiscalRangeLabel(form.fiscalYearStartMonth)}
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="taxFramework" help={t("fiscal.taxFrameworkHint")}>
                {t("fiscal.taxFramework")}
              </FieldLabel>
              <Select
                id="taxFramework"
                value={form.taxFramework ?? "asc740"}
                onChange={(e) =>
                  setForm((f) => ({ ...f, taxFramework: e.target.value as "asc740" | "ias12" }))
                }
              >
                <option value="asc740">{t("fiscal.frameworkAsc740")}</option>
                <option value="ias12">{t("fiscal.frameworkIas12")}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="reportingFramework" help={t("fiscal.reportingFrameworkHint")}>
                {t("fiscal.reportingFramework")}
              </FieldLabel>
              <Select
                id="reportingFramework"
                value={form.reportingFramework}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    reportingFramework: e.target.value as "us_gaap" | "ifrs",
                  }))
                }
              >
                <option value="us_gaap">{t("fiscal.reportingFrameworkUsGaap")}</option>
                <option value="ifrs">{t("fiscal.reportingFrameworkIfrs")}</option>
              </Select>
            </div>
          </div>
          {startMonthChanged ? (
            <Alert variant="warning">
              <AlertDescription>
                {t.rich("fiscal.warning", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {revenueRecognition ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("revenue.title")}</CardTitle>
            <CardDescription>
              {t("revenue.description")}{" "}
              <Link
                href="/docs/revenue-recognition"
                className="font-medium text-teal-700 hover:underline dark:text-teal-300"
              >
                {t("revenue.learnMore")}
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel
                htmlFor="fairValueRangePolicy"
                help={t("revenue.fairValueRangePolicy.hint")}
              >
                {t("revenue.fairValueRangePolicy.label")}
              </FieldLabel>
              <Select
                id="fairValueRangePolicy"
                value={form.fairValueRangePolicy}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    fairValueRangePolicy: e.target.value === "off" ? "off" : "warn",
                  }))
                }
              >
                <option value="warn">{t("revenue.fairValueRangePolicy.warn")}</option>
                <option value="off">{t("revenue.fairValueRangePolicy.off")}</option>
              </Select>
            </div>
            {revenueContracts ? (
              <div className="space-y-1.5">
                <FieldLabel htmlFor="contractCreation" help={t("revenue.contractCreation.hint")}>
                  {t("revenue.contractCreation.label")}
                </FieldLabel>
                <Select
                  id="contractCreation"
                  value={form.contractCreation}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      contractCreation: e.target.value === "booking" ? "booking" : "first_billing",
                    }))
                  }
                >
                  <option value="first_billing">
                    {t("revenue.contractCreation.firstBilling")}
                  </option>
                  <option value="booking">{t("revenue.contractCreation.booking")}</option>
                </Select>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {saasMetricsEnabled ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("saasMetrics.title")}</CardTitle>
            <CardDescription>{t("saasMetrics.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel
                htmlFor="evergreenBookingMonths"
                help={t("saasMetrics.evergreenBookingMonths.hint")}
              >
                {t("saasMetrics.evergreenBookingMonths.label")}
              </FieldLabel>
              <Input
                id="evergreenBookingMonths"
                type="number"
                min={1}
                step={1}
                value={form.saasMetrics.evergreenBookingMonths}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    saasMetrics: { ...f.saasMetrics, evergreenBookingMonths: e.target.value },
                  }))
                }
              />
            </div>
            <label className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={form.saasMetrics.billingsUsePreTaxSubtotal}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    saasMetrics: { ...f.saasMetrics, billingsUsePreTaxSubtotal: e.target.checked },
                  }))
                }
                className="mt-1 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              <span>{t("saasMetrics.billingsUsePreTaxSubtotal.label")}</span>
            </label>
            <label className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={form.saasMetrics.customerCreditsReduceBillings}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    saasMetrics: {
                      ...f.saasMetrics,
                      customerCreditsReduceBillings: e.target.checked,
                    },
                  }))
                }
                className="mt-1 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              <span>{t("saasMetrics.customerCreditsReduceBillings.label")}</span>
            </label>
          </CardContent>
          <CardContent className="pt-0">
            <SaasMetricsNormalization />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("approvals.title")}</CardTitle>
          <CardDescription>{t("approvals.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/admin/flows"
            className="font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t("approvals.manageFlows")}
          </Link>
        </CardContent>
      </Card>

      {/* Fiscal year — the headline setting */}
      <Card>
        <CardHeader>
          <CardTitle>{t("billing.title")}</CardTitle>
          <CardDescription>{t("billing.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <FieldLabel
              htmlFor="billing-default-terms"
              help={t("billing.fields.defaultPaymentTerms.hint")}
            >
              {t("billing.fields.defaultPaymentTerms.label")}
            </FieldLabel>
            <SearchSelect
              id="billing-default-terms"
              value={form.billing.defaultPaymentTermsId}
              onChange={(v) =>
                setForm((f) => ({ ...f, billing: { defaultPaymentTermsId: v ?? "" } }))
              }
              options={paymentTerms.map((pt) => ({ value: pt.id, label: pt.label }))}
              placeholder={t("billing.termsPlaceholder")}
              searchPlaceholder={t("billing.termsSearchPlaceholder")}
              sheetTitle={t("billing.fields.defaultPaymentTerms.label")}
              clearable
              emptyLabel={tCommon("labels.notSet")}
              ariaLabel={t("billing.fields.defaultPaymentTerms.label")}
            />
          </div>
        </CardContent>
      </Card>

      {cashSalesEnabled ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("cashSales.title")}</CardTitle>
            <CardDescription>{t("cashSales.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="cash-walk-in" help={t("cashSales.fields.walkInCustomer.hint")}>
                {t("cashSales.fields.walkInCustomer.label")}
              </FieldLabel>
              <SearchSelect
                id="cash-walk-in"
                value={form.cashSales.walkInCustomerId}
                onChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    cashSales: { ...EMPTY_CASH_SALES, ...f.cashSales, walkInCustomerId: v ?? "" },
                  }))
                }
                options={customers.map((c) => ({ value: c.id, label: c.label }))}
                placeholder={t("cashSales.customerPlaceholder")}
                searchPlaceholder={t("cashSales.customerSearchPlaceholder")}
                sheetTitle={t("cashSales.fields.walkInCustomer.label")}
                clearable
                emptyLabel={tCommon("labels.notSet")}
                ariaLabel={t("cashSales.fields.walkInCustomer.label")}
              />
            </div>
            {(
              ["defaultCashAccountId", "defaultCardAccountId", "defaultBankAccountId"] as const
            ).map((key) => {
              const label = t(`cashSales.fields.${key}.label`);
              return (
                <div key={key} className="space-y-1.5">
                  <FieldLabel htmlFor={`cash-${key}`} help={t(`cashSales.fields.${key}.hint`)}>
                    {label}
                  </FieldLabel>
                  <SearchSelect
                    id={`cash-${key}`}
                    value={form.cashSales[key]}
                    onChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        cashSales: { ...EMPTY_CASH_SALES, ...f.cashSales, [key]: v ?? "" },
                      }))
                    }
                    options={settlementAccountOptions}
                    placeholder={t("cashSales.accountPlaceholder")}
                    searchPlaceholder={t("cashSales.accountSearchPlaceholder")}
                    sheetTitle={label}
                    clearable
                    emptyLabel={tCommon("labels.notSet")}
                    ariaLabel={label}
                  />
                </div>
              );
            })}
            {/* Fiscal year — the headline setting */}
            <div className="space-y-1.5 sm:col-span-2">
              <FieldLabel help={t("cashSales.fields.depositAccountIds.hint")}>
                {t("cashSales.fields.depositAccountIds.label")}
              </FieldLabel>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {/* Fiscal year — the headline setting */}
                {accounts
                  .filter((a) => a.type === "asset_bank" || a.type === "asset_current_other")
                  .map((account) => (
                    <label
                      key={account.id}
                      className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300"
                    >
                      <input
                        type="checkbox"
                        checked={(form.cashSales.depositAccountIds ?? []).includes(account.id)}
                        onChange={(e) =>
                          setForm((f) => {
                            const current = f.cashSales.depositAccountIds ?? [];
                            const next = e.target.checked
                              ? [...current, account.id]
                              : current.filter((id) => id !== account.id);
                            return {
                              ...f,
                              cashSales: {
                                ...EMPTY_CASH_SALES,
                                ...f.cashSales,
                                depositAccountIds: next,
                              },
                            };
                          })
                        }
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span>{account.label}</span>
                    </label>
                  ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Control accounts */}
      <Card id="control-accounts">
        <CardHeader>
          <CardTitle>{t("controlAccounts.title")}</CardTitle>
          <CardDescription>{t("controlAccounts.description")}</CardDescription>
        </CardHeader>
        {multiSubsidiary ? (
          <CardContent className="pt-0">
            <Alert>
              <AlertDescription>{t("controlAccounts.defaultsNote")}</AlertDescription>
            </Alert>
          </CardContent>
        ) : null}
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {controlAccountRoles.map((role) => {
            const label = t(`controlAccounts.fields.${role}.label`);
            const allowedTypes = controlAccountPolicy[role] ?? [];
            const expected = expectedTypesLabel(allowedTypes);
            const picker = controlAccountPickerOptions({
              accounts,
              allowedTypes,
              selectedId: form.controlAccounts[role] || undefined,
              incompatibleLabel: (accountLabel) =>
                t("controlAccounts.incompatibleOption", { account: accountLabel }),
            });
            return (
              <div key={role} className="space-y-1.5">
                <FieldLabel
                  htmlFor={`ctrl-${role}`}
                  help={t(`controlAccounts.fields.${role}.hint`)}
                >
                  {label}
                </FieldLabel>
                <SearchSelect
                  id={`ctrl-${role}`}
                  value={form.controlAccounts[role] ?? ""}
                  onChange={(v) => setControl(role, v)}
                  options={picker.options}
                  placeholder={t("controlAccounts.selectPlaceholder")}
                  searchPlaceholder={t("controlAccounts.searchPlaceholder")}
                  sheetTitle={label}
                  clearable
                  emptyLabel={
                    picker.options.length === 0
                      ? t("controlAccounts.noEligibleAccounts", { types: expected })
                      : tCommon("labels.notSet")
                  }
                  ariaLabel={label}
                />
                <p
                  id={`ctrl-${role}-expected`}
                  className={
                    picker.selectedIncompatible
                      ? "text-xs text-amber-700 dark:text-amber-400"
                      : "text-xs text-slate-500 dark:text-slate-400"
                  }
                >
                  {picker.selectedIncompatible
                    ? t("controlAccounts.incompatibleSelected", { role: label, types: expected })
                    : t("controlAccounts.expectedTypes", { types: expected })}
                </p>
              </div>
            );
          })}
          <div className="space-y-1.5">
            <FieldLabel
              htmlFor="partylessControlPolicy"
              help={t("controlAccounts.partylessPolicy.hint")}
            >
              {t("controlAccounts.partylessPolicy.label")}
            </FieldLabel>
            <Select
              id="partylessControlPolicy"
              value={form.partylessControlPolicy ?? "warn"}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  partylessControlPolicy: e.target.value === "refuse" ? "refuse" : "warn",
                }))
              }
            >
              <option value="warn">{t("controlAccounts.partylessPolicy.warn")}</option>
              <option value="refuse">{t("controlAccounts.partylessPolicy.refuse")}</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button
          variant="outline"
          disabled={saving}
          onClick={() =>
            setForm({
              ...initial,
              saasMetrics: initial.saasMetrics ?? {
                evergreenBookingMonths: "12",
                billingsUsePreTaxSubtotal: true,
                customerCreditsReduceBillings: true,
              },
              cashSales: { ...EMPTY_CASH_SALES, ...(initial.cashSales ?? {}) },
              billing: { defaultPaymentTermsId: initial.billing?.defaultPaymentTermsId ?? "" },
              legalIdentity: initial.legalIdentity ?? EMPTY_LEGAL_IDENTITY,
            })
          }
        >
          {tCommon("actions.reset")}
        </Button>
        <Button disabled={saving} onClick={save}>
          {saving ? tCommon("actions.saving") : t("saveSettings")}
        </Button>
      </div>
    </div>
  );
}
