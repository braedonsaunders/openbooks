import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import {
  CONTROL_ACCOUNT_ROLES,
  CONTROL_ACCOUNT_TYPE_POLICY,
} from "@openbooks/engine/records/control-accounts";
import { db } from "@openbooks/engine/platform/db";
import { canonicalTimeZone, listCanonicalTimeZones } from "@openbooks/engine/platform/time-zone";
import { DEFAULT_LOCALE, isLocale } from "../../../../../i18n/config";
import { isFeatureEnabled, subsidiaryFeatureEnabled } from "../../../../../lib/features";
import { SettingsForm, type AccountOption } from "../../settings/SettingsForm";
import {
  EMPTY_COMPANY_ADDRESS,
  isLegalForm,
  isTaxClassification,
  readCompanyAddress,
  readTaxIds,
} from "@openbooks/engine/organization/company-identity";
import { readBillingSettings, readCashSalesSettings } from "../../../../../lib/company-settings";
import { SampleCompanyPicker } from "../../../../../components/sample-company-picker";
import { parsePartylessControlPolicy } from "@openbooks/engine/ledger/partyless-control-policy";

/**
 * Company & Accounting settings, rendered as the Setup "Company" tab. This is
 * the native company configuration workspace. Loads the organization's
 * current values and the postable accounts for the control-account pickers,
 * then hands them to the existing client form (which PUTs to /api/admin/settings).
 */
export async function CompanyTab({ orgId }: { orgId: string }) {
  const t = await getTranslations("admin.setup");

  const [
    org,
    accounts,
    currencies,
    multiSubsidiary,
    revenueRecognition,
    revenueContracts,
    saasMetricsEnabled,
    cashSalesEnabled,
    customers,
    paymentTerms,
  ] = await Promise.all([
    db.execute(
      sql`
      select name, legal_name, base_currency, country, tax_ids, settings
        from orgs where id = ${orgId}`,
      "objects",
    ),
    db.execute(
      sql`
      select id, number, name, type from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`,
      "objects",
    ),
    db.execute(sql`select code, name from currencies order by code`, "objects"),
    subsidiaryFeatureEnabled(orgId),
    isFeatureEnabled(orgId, "revenueRecognition"),
    isFeatureEnabled(orgId, "revenueContracts"),
    isFeatureEnabled(orgId, "saasMetrics"),
    isFeatureEnabled(orgId, "cashSales"),
    db.execute(
      sql`
      select p.id, p.display_name from parties p
       where p.org_id = ${orgId} and p.is_active
         and exists (
           select 1 from customer_roles cr
            where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active
         )
       order by p.display_name limit 2000`,
      "objects",
    ),
    db.execute(
      sql`
      select id, name, net_days from payment_terms
       where org_id = ${orgId} and is_active
       order by name`,
      "objects",
    ),
  ]);

  const row = org[0];
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  const control = (settings.controlAccounts ?? {}) as Record<string, string>;

  const accountOptions: AccountOption[] = accounts.map((a) => ({
    id: a.id as string,
    label: `${a.number ? `${a.number} · ` : ""}${a.name}`,
    type: a.type as string,
  }));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {t("entities.company.title")}
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("entities.company.description")}
        </p>
      </div>
      <SettingsForm
        initial={{
          name: (row?.name as string) ?? "",
          legalName: (row?.legal_name as string | null) ?? "",
          country: (row?.country as string) ?? "",
          baseCurrency: (row?.base_currency as string) ?? "",
          timeZone: canonicalTimeZone(settings.timeZone) ?? "UTC",
          fiscalYearStartMonth:
            typeof settings.fiscalYearStartMonth === "number" ? settings.fiscalYearStartMonth : 1,
          reportingFramework: settings.reportingFramework === "ifrs" ? "ifrs" : "us_gaap",
          taxFramework: settings.taxFramework === "ias12" ? "ias12" : "asc740",
          defaultLocale: isLocale(settings.defaultLocale) ? settings.defaultLocale : DEFAULT_LOCALE,
          reportPdfStyle: settings.reportPdfStyle === "formal" ? "formal" : "modern",
          fairValueRangePolicy:
            (settings.revenue as Record<string, unknown> | undefined)?.fairValueRangePolicy ===
            "off"
              ? "off"
              : "warn",
          contractCreation:
            (settings.revenue as Record<string, unknown> | undefined)?.contractCreation ===
            "booking"
              ? "booking"
              : "first_billing",
          saasMetrics: (() => {
            const definitions = settings.saasMetrics as Record<string, unknown> | undefined;
            return {
              evergreenBookingMonths:
                typeof definitions?.evergreenBookingMonths === "string"
                  ? definitions.evergreenBookingMonths
                  : "12",
              billingsUsePreTaxSubtotal: definitions?.billingsUsePreTaxSubtotal !== false,
              customerCreditsReduceBillings: definitions?.customerCreditsReduceBillings !== false,
            };
          })(),
          controlAccounts: Object.fromEntries(
            CONTROL_ACCOUNT_ROLES.map((role) => [role, control[role] ?? ""]),
          ),
          partylessControlPolicy: parsePartylessControlPolicy(
            (settings.ledger as Record<string, unknown> | undefined)?.partylessControlPolicy,
          ),
          legalIdentity: {
            address: readCompanyAddress(settings.companyAddress) ?? {
              ...EMPTY_COMPANY_ADDRESS,
            },
            legalForm: isLegalForm(settings.legalForm) ? settings.legalForm : "",
            taxClassification: isTaxClassification(settings.taxClassification)
              ? settings.taxClassification
              : "",
            taxIds: readTaxIds(row?.tax_ids),
          },
          billing: (() => {
            const stored = readBillingSettings(settings.billing);
            return { defaultPaymentTermsId: stored.defaultPaymentTermsId ?? "" };
          })(),
          cashSales: (() => {
            const stored = readCashSalesSettings(
              (settings.cashSales ?? {}) as Record<string, unknown>,
            );
            return {
              walkInCustomerId: stored.walkInCustomerId ?? "",
              defaultCashAccountId: stored.defaultCashAccountId ?? "",
              defaultCardAccountId: stored.defaultCardAccountId ?? "",
              defaultBankAccountId: stored.defaultBankAccountId ?? "",
              depositAccountIds: stored.depositAccountIds ?? [],
            };
          })(),
        }}
        controlAccountRoles={CONTROL_ACCOUNT_ROLES}
        controlAccountPolicy={CONTROL_ACCOUNT_TYPE_POLICY}
        accounts={accountOptions}
        currencies={currencies as { code: string; name: string }[]}
        timeZones={listCanonicalTimeZones()}
        multiSubsidiary={multiSubsidiary}
        revenueRecognition={revenueRecognition}
        revenueContracts={revenueContracts}
        saasMetricsEnabled={saasMetricsEnabled}
        cashSalesEnabled={cashSalesEnabled}
        customers={(customers as { id: string; display_name: string }[]).map((c) => ({
          id: c.id,
          label: c.display_name,
        }))}
        paymentTerms={(paymentTerms as { id: string; name: string }[]).map((pt) => ({
          id: pt.id,
          label: pt.name,
        }))}
      />
      <SampleCompanyPicker />
    </div>
  );
}
