import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { lockLedgerSetupFence } from "@openbooks/engine/organization/ledger-setup";
import {
  assertValidControlAccountMappings,
  CONTROL_ACCOUNT_ROLE_LABELS,
  CONTROL_ACCOUNT_ROLES,
  ControlAccountsIncompleteError,
  type ControlAccountRecord,
  type OrgControlAccounts,
} from "@openbooks/engine/records/control-accounts";
import { canonicalTimeZone } from "@openbooks/engine/platform/time-zone";
import {
  isLegalForm,
  isTaxClassification,
  normalizeCompanyAddress,
  normalizeTaxIds,
  readCompanyAddress,
  readTaxIds,
  taxClassificationsFor,
  taxIdScheme,
  type LegalForm,
} from "@openbooks/engine/organization/company-identity";
import { isFeatureEnabled } from "./features";
import { isUuid } from "./list-params";
import { DEFAULT_LOCALE, isLocale } from "../i18n/config";
import { isCountryCode, normalizeCountryCode } from "./countries";
import { periodDerivationSql, periodDerivationStagingSql } from "./fiscal-periods";
import {
  PARTYLESS_CONTROL_POLICIES,
  parsePartylessControlPolicy,
  type PartylessControlPolicy,
} from "@openbooks/engine/ledger/partyless-control-policy";
import { assertUnrestrictedScope } from "@openbooks/engine/organization/scope";

/** Transport-neutral outcome: the HTTP status the route would answer with and
 *  the JSON body. Adapters (route, assistant/MCP tool) map it onto their wire. */
export type CompanySettingsResult = { status: number; body: Record<string, unknown> };

/**
 * Company & Accounting settings. GET preserves the user-administration view of
 * organization identity, locale, and the two independent accounting policies.
 * PUT persists the complete setup policy: identity, base currency, fiscal
 * calendar, reporting/tax policy, and control accounts.
 *
 * Reads retain the existing user-administration gate because the response is
 * still the company-administration view rather than a posting endpoint.
 * Every write is a setup operation and is separately gated by
 * admin.setup.manage: even an
 * identity-only payload shares one authoritative settings mutation boundary
 * with ledger policy and must never inherit user-administration authority.
 *
 * A fresh organization may change its fiscal-year start month. Once its active
 * default calendar has posted/reversed journals or a non-open period lock, the
 * fiscal foundation is immutable and the transaction refuses the entire PUT.
 */

export const SETTINGS_READ_PERMISSION = "admin.users.manage";
export const SETTINGS_WRITE_PERMISSION = "admin.setup.manage";

/**
 * Cash-sale till defaults stored under `orgs.settings.cashSales`: the
 * customer unattributed counter sales post against, and the clearing/bank
 * accounts new tenders prefill per channel, plus the bank accounts till
 * drops may move cash into. All five are optional; unknown keys refuse so
 * a typo cannot silently park.
 */
export const CASH_SALES_SETTING_KEYS = [
  "walkInCustomerId",
  "defaultCashAccountId",
  "defaultCardAccountId",
  "defaultBankAccountId",
  "depositAccountIds",
] as const;

export type CashSalesSettings = {
  walkInCustomerId: string | null;
  defaultCashAccountId: string | null;
  defaultCardAccountId: string | null;
  defaultBankAccountId: string | null;
  /** Bank accounts a cashier's till drop may move cash into. Empty disables drops. */
  depositAccountIds: string[];
};

/**
 * Company default payment terms stored under `orgs.settings.billing`: the
 * terms invoices and bills fall back to when the counterparty names none.
 * Null means no company default; unknown keys and non-id values drop.
 */
export const BILLING_SETTING_KEYS = ["defaultPaymentTermsId"] as const;

export type BillingSettings = {
  defaultPaymentTermsId: string | null;
};

/** Normalize the stored billing defaults: unknown keys and non-id values drop. */
export function readBillingSettings(raw: unknown): BillingSettings {
  const bag = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const id = bag.defaultPaymentTermsId;
  return {
    defaultPaymentTermsId: typeof id === "string" && isUuid(id) ? id : null,
  };
}

/** Normalize the stored till defaults: unknown keys and non-id values drop. */
export function readCashSalesSettings(raw: unknown): CashSalesSettings {
  const bag = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const pick = (key: string): string | null =>
    typeof bag[key] === "string" && isUuid(bag[key] as string) ? (bag[key] as string) : null;
  const rawDeposit = Array.isArray(bag.depositAccountIds) ? bag.depositAccountIds : [];
  return {
    walkInCustomerId: pick("walkInCustomerId"),
    defaultCashAccountId: pick("defaultCashAccountId"),
    defaultCardAccountId: pick("defaultCardAccountId"),
    defaultBankAccountId: pick("defaultBankAccountId"),
    depositAccountIds: [
      ...new Set(rawDeposit.filter((id): id is string => typeof id === "string" && isUuid(id))),
    ],
  };
}

function fiscalCalendarLockedResponse(): CompanySettingsResult {
  return {
    status: 409,
    body: {
      error: "fiscal-calendar-locked",
      message: "Cannot change the fiscal calendar after postings or period closure.",
    },
  };
}

/** The Company & Accounting settings view (identity, locale, frameworks) —
 *  the same shape the settings screen renders. */
export async function readCompanySettings(orgId: string): Promise<CompanySettingsResult> {
  const org = await db.execute(
    sql`
    select id, name, legal_name, country, tax_ids, settings
      from orgs where id = ${orgId}`,
    "objects",
  );

  const row = org[0];
  if (!row) return { status: 404, body: { error: "org not found" } };
  const settings = (row.settings ?? {}) as Record<string, unknown>;

  return {
    status: 200,
    body: {
      org: {
        name: row.name as string,
        legalName: (row.legal_name as string | null) ?? "",
        country: row.country as string,
        // Legal identity: registered address, legal form, tax classification
        // and the tax/registration identifiers documents print.
        address: readCompanyAddress(settings.companyAddress),
        legalForm: isLegalForm(settings.legalForm) ? settings.legalForm : null,
        taxClassification: isTaxClassification(settings.taxClassification)
          ? settings.taxClassification
          : null,
        taxIds: readTaxIds(row.tax_ids),
        defaultLocale: isLocale(settings.defaultLocale) ? settings.defaultLocale : DEFAULT_LOCALE,
        timeZone: canonicalTimeZone(settings.timeZone) ?? "UTC",
        reportingFramework:
          settings.reportingFramework === "ifrs" || settings.reportingFramework === "us_gaap"
            ? settings.reportingFramework
            : null,
        taxFramework: settings.taxFramework === "ias12" ? "ias12" : "asc740",
        // The company default payment terms are core billing configuration,
        // always visible; only the till defaults below are feature-gated.
        billing: readBillingSettings(settings.billing),
        // A gated feature's settings stay hidden while the gate is off; the
        // stored values are kept and reappear with the switch.
        ...((await isFeatureEnabled(orgId, "cashSales"))
          ? { cashSales: readCashSalesSettings(settings.cashSales) }
          : {}),
      },
    },
  };
}

/**
 * The one authoritative Company & Accounting settings mutation. The
 * /api/admin/settings route and the `update_company_settings` application
 * tool (chat + MCP) both call this, so every surface shares the row lock,
 * validation, the fiscal-calendar and base-currency immutability rules,
 * control-account checks, period derivation, and audit evidence.
 */
export async function updateCompanySettings(
  actor: { orgId: string; id: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
  rawBody: Record<string, unknown>,
): Promise<CompanySettingsResult> {
  assertUnrestrictedScope(actor.allowedSubsidiaryIds);
  const { orgId } = actor;
  const body = rawBody as {
    name?: unknown;
    legalName?: unknown;
    country?: unknown;
    baseCurrency?: unknown;
    fiscalYearStartMonth?: unknown;
    reportingFramework?: unknown;
    taxFramework?: unknown;
    controlAccounts?: unknown;
    cashSales?: unknown;
    billing?: unknown;
    defaultLocale?: unknown;
    timeZone?: unknown;
    reportPdfStyle?: unknown;
    fairValueRangePolicy?: unknown;
    contractCreation?: unknown;
    saasMetrics?: unknown;
    partylessControlPolicy?: unknown;
    address?: unknown;
    legalForm?: unknown;
    taxClassification?: unknown;
    taxIds?: unknown;
  };

  // This feature probe does not contribute persisted state. Do it before the
  // row lock so disabled-feature requests cannot hold an accounting-policy
  // writer behind unrelated feature resolution.
  if (
    body.fairValueRangePolicy !== undefined &&
    !(await isFeatureEnabled(orgId, "revenueRecognition"))
  ) {
    return { status: 404, body: { error: "not_found" } };
  }
  if (body.saasMetrics !== undefined && !(await isFeatureEnabled(orgId, "saasMetrics"))) {
    return { status: 404, body: { error: "not_found" } };
  }
  // Contract creation belongs to scoped revenue contracts; without the
  // switch the choice has no surface and the write is refused, never stored.
  if (body.contractCreation !== undefined && !(await isFeatureEnabled(orgId, "revenueContracts"))) {
    return { status: 404, body: { error: "not_found" } };
  }

  // Lock first, then re-read, derive, persist, and audit through one
  // transaction. Concurrent editors therefore build on the latest committed
  // JSON document instead of spreading a stale snapshot over one another.
  return db.transaction(async (tx) => {
    const postingPolicyKeys: (keyof typeof body)[] = [
      "baseCurrency",
      "fiscalYearStartMonth",
      "reportingFramework",
      "taxFramework",
      "controlAccounts",
      "timeZone",
      "partylessControlPolicy",
    ];
    if (postingPolicyKeys.some((key) => body[key] !== undefined)) {
      await lockLedgerSetupFence(tx, orgId, "exclusive");
    }
    const existing = await tx.execute(
      sql`
    select name, legal_name, base_currency, country, tax_ids, settings
      from orgs where id = ${orgId} for update`,
      "objects",
    );
    const cur = existing[0];
    if (!cur) return { status: 404, body: { error: "org not found" } };
    const settings = (cur.settings ?? {}) as Record<string, unknown>;

    const changes: Record<string, unknown> = {};
    const sets: SQL[] = [];

    // --- display name (required) ---
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return { status: 400, body: { error: "display name is required" } };
      }
      const name = body.name.trim();
      if (name !== cur.name) {
        sets.push(sql`name = ${name}`);
        changes.name = [cur.name, name];
      }
    }

    // --- legal name (optional) ---
    if (body.legalName !== undefined) {
      if (typeof body.legalName !== "string") {
        return { status: 400, body: { error: "legal name must be text" } };
      }
      const legalName = body.legalName.trim() || null;
      if (legalName !== cur.legal_name) {
        sets.push(sql`legal_name = ${legalName}`);
        changes.legalName = [cur.legal_name, legalName];
      }
    }

    // --- country (ISO 3166-1 alpha-2) ---
    if (body.country !== undefined) {
      const country = normalizeCountryCode(body.country);
      if (!country) {
        return { status: 400, body: { error: "country must be a valid ISO country code" } };
      }
      if (country !== cur.country) {
        sets.push(sql`country = ${country}`);
        changes.country = [cur.country, country];
      }
    }

    // --- legal identity: registered address, legal form, tax classification
    // and tax/registration identifiers. Validated against the country this
    // same save leaves the company in; refusals name the field and the fix.
    const effectiveCountry = (normalizeCountryCode(body.country) ?? cur.country) as string;
    const identitySettings: {
      key: "companyAddress" | "legalForm" | "taxClassification";
      value: unknown;
    }[] = [];
    if (body.address !== undefined) {
      const result = normalizeCompanyAddress(body.address, isCountryCode);
      if (!result.ok) {
        const { field, reason } = result.problem;
        const message =
          reason === "required"
            ? `the company address needs a ${field === "line1" ? "street address" : "city"} — complete it or clear every address field`
            : reason === "invalid_country"
              ? "the company address needs a valid country"
              : `the company address ${field} is too long — shorten it to 200 characters`;
        return {
          status: 400,
          body: { error: message, code: "invalid-company-address", field, reason },
        };
      }
      identitySettings.push({ key: "companyAddress", value: result.address });
    }
    const storedLegalForm: LegalForm | null = isLegalForm(settings.legalForm)
      ? settings.legalForm
      : null;
    let effectiveLegalForm = storedLegalForm;
    if (body.legalForm !== undefined) {
      if (body.legalForm !== null && !isLegalForm(body.legalForm)) {
        return {
          status: 400,
          body: {
            error: "legal form is not one of the supported business structures",
            code: "invalid-legal-form",
          },
        };
      }
      effectiveLegalForm = body.legalForm;
      identitySettings.push({ key: "legalForm", value: body.legalForm });
    }
    let effectiveClassification = isTaxClassification(settings.taxClassification)
      ? settings.taxClassification
      : null;
    if (body.taxClassification !== undefined) {
      if (body.taxClassification !== null && !isTaxClassification(body.taxClassification)) {
        return {
          status: 400,
          body: {
            error: "tax classification is not one of the supported treatments",
            code: "invalid-tax-classification",
          },
        };
      }
      effectiveClassification = body.taxClassification;
      identitySettings.push({ key: "taxClassification", value: body.taxClassification });
    }
    // A form, country or classification change must leave a combination the
    // law allows (an LLC may elect S status only in the US; a sole
    // proprietorship is taxed with its owner).
    if (
      effectiveClassification !== null &&
      (body.legalForm !== undefined ||
        body.taxClassification !== undefined ||
        body.country !== undefined) &&
      !taxClassificationsFor(effectiveLegalForm, effectiveCountry).includes(effectiveClassification)
    ) {
      return {
        status: 400,
        body: {
          error:
            "the tax classification does not apply to this legal form in this country — choose a classification the structure can elect",
          code: "tax-classification-mismatch",
          legalForm: effectiveLegalForm,
          taxClassification: effectiveClassification,
        },
      };
    }
    const storedTaxIds = readTaxIds(cur.tax_ids);
    if (body.taxIds !== undefined) {
      if (body.taxIds === null || typeof body.taxIds !== "object" || Array.isArray(body.taxIds)) {
        return {
          status: 400,
          body: {
            error: "taxIds must be an object keyed by identifier scheme",
            code: "invalid-tax-id",
          },
        };
      }
      const result = normalizeTaxIds(
        body.taxIds as Record<string, unknown>,
        effectiveCountry,
        storedTaxIds,
      );
      if (!result.ok) {
        const { scheme, reason } = result.problem;
        const label = taxIdScheme(scheme)?.printLabel ?? scheme;
        const example = taxIdScheme(scheme)?.example;
        const message =
          reason === "unknown_scheme"
            ? `${scheme} is not a supported tax identifier`
            : reason === "not_in_country"
              ? `${label} is not issued in ${effectiveCountry} — remove it or change the company's country`
              : `${label} is not a valid number${example ? ` — enter it like ${example}` : ""}`;
        return { status: 400, body: { error: message, code: "invalid-tax-id", scheme, reason } };
      }
      if (JSON.stringify(result.taxIds) !== JSON.stringify(storedTaxIds)) {
        sets.push(sql`tax_ids = ${JSON.stringify(result.taxIds)}::jsonb`);
        changes.taxIds = [storedTaxIds, result.taxIds];
      }
    }

    // --- base currency (must be a known currency) ---
    if (body.baseCurrency !== undefined) {
      if (typeof body.baseCurrency !== "string" || !/^[A-Z]{3}$/.test(body.baseCurrency)) {
        return { status: 400, body: { error: "base currency must be a 3-letter code" } };
      }
      const known = await tx.execute(
        sql`select 1 from currencies where code = ${body.baseCurrency} limit 1`,
        "objects",
      );
      if (!known[0]) {
        return {
          status: 400,
          body: {
            error: `unknown currency "${body.baseCurrency}" — add it to the currency table first`,
          },
        };
      }
      if (body.baseCurrency !== cur.base_currency) {
        const ledgerEvidence = await tx.execute(
          sql`
        select exists (
          select 1 from journal_lines where org_id = ${orgId} limit 1
        ) as exists`,
          "objects",
        );
        if (ledgerEvidence[0]?.exists) {
          return {
            status: 409,
            body: {
              error: "base-currency-locked",
              message: "Cannot change base currency after postings exist.",
            },
          };
        }
        sets.push(sql`base_currency = ${body.baseCurrency}`);
        changes.baseCurrency = [cur.base_currency, body.baseCurrency];
      }
    }

    // --- control accounts (validated against real, non-summary accounts) ---
    let nextControl: Record<string, string> | undefined;
    if (body.controlAccounts !== undefined) {
      if (
        typeof body.controlAccounts !== "object" ||
        body.controlAccounts === null ||
        Array.isArray(body.controlAccounts)
      ) {
        return { status: 400, body: { error: "controlAccounts must be an object" } };
      }
      const input = body.controlAccounts as Record<string, unknown>;
      const unknownRoles = Object.keys(input).filter(
        (key) => !CONTROL_ACCOUNT_ROLES.some((role) => role === key),
      );
      if (unknownRoles.length > 0) {
        return {
          status: 400,
          body: {
            error: unknownRoles.map((key) => `unknown control account role ${key}`).join("; "),
          },
        };
      }
      const currentControl =
        settings.controlAccounts && typeof settings.controlAccounts === "object"
          ? (settings.controlAccounts as Record<string, unknown>)
          : {};
      const collected: Record<string, unknown> = { ...currentControl };
      for (const key of CONTROL_ACCOUNT_ROLES) {
        const v = input[key];
        if (v === undefined) continue;
        if (v === null || v === "") {
          delete collected[key];
          continue;
        }
        if (typeof v !== "string" || !isUuid(v)) {
          return {
            status: 400,
            body: {
              error: `${CONTROL_ACCOUNT_ROLE_LABELS[key]} must be an account id`,
              code: "control-account-invalid",
              role: key,
              reason: "missing",
            },
          };
        }
        collected[key] = v;
      }
      const ids = new Set<string>();
      for (const key of CONTROL_ACCOUNT_ROLES) {
        const accountId = collected[key];
        if (accountId === undefined) continue;
        if (typeof accountId !== "string" || !isUuid(accountId)) {
          return {
            status: 400,
            body: {
              error: `${CONTROL_ACCOUNT_ROLE_LABELS[key]}: stored control account id is invalid — choose the account again`,
              code: "control-account-invalid",
              role: key,
              reason: "missing",
            },
          };
        }
        ids.add(accountId);
      }
      if (ids.size > 0) {
        const found = await tx.execute<ControlAccountRecord>(
          sql`
        select id, type, is_active as "isActive", is_summary as "isSummary"
          from accounts
         where org_id = ${orgId} and id in (${sql.join(
           [...ids].map((i) => sql`${i}`),
           sql`, `,
         )})
         for share`,
          "objects",
        );
        try {
          assertValidControlAccountMappings(collected as OrgControlAccounts, found);
        } catch (error) {
          if (error instanceof ControlAccountsIncompleteError) {
            // The message names the role in plain words; the structured
            // detail lets the settings screen restate it in the operator's
            // language beside the field.
            return {
              status: 400,
              body: {
                error: error.message,
                code: "control-account-invalid",
                ...(error.role ? { role: error.role } : {}),
                ...(error.reason ? { reason: error.reason } : {}),
                ...(error.accountType ? { accountType: error.accountType } : {}),
                ...(error.allowedTypes ? { allowedTypes: error.allowedTypes } : {}),
              },
            };
          }
          throw error;
        }
      }
      nextControl = collected as Record<string, string>;
    }

    // --- cash-sale till defaults (walk-in customer, default tender accounts) ---
    // Paid-at-sale defaults live beside the control accounts: the party
    // unattributed counter sales post against, and the clearing/bank accounts
    // new tenders prefill. Storing them is harmless with the feature off;
    // the cash-sales surface hides while the data stays.
    let nextCashSales: Record<string, string> | undefined;
    if (body.cashSales !== undefined) {
      if (
        typeof body.cashSales !== "object" ||
        body.cashSales === null ||
        Array.isArray(body.cashSales)
      ) {
        return { status: 400, body: { error: "cashSales must be an object" } };
      }
      const input = body.cashSales as Record<string, unknown>;
      const unknownKeys = Object.keys(input).filter(
        (key) => !CASH_SALES_SETTING_KEYS.some((known) => known === key),
      );
      if (unknownKeys.length > 0) {
        return {
          status: 400,
          body: {
            error: unknownKeys.map((key) => `unknown cash sales setting ${key}`).join("; "),
          },
        };
      }
      const currentCashSales =
        settings.cashSales && typeof settings.cashSales === "object"
          ? (settings.cashSales as Record<string, unknown>)
          : {};
      const collected: Record<string, unknown> = { ...currentCashSales };
      for (const key of CASH_SALES_SETTING_KEYS) {
        if (key === "depositAccountIds") continue;
        const v = input[key];
        if (v === undefined) continue;
        if (v === null || v === "") {
          delete collected[key];
          continue;
        }
        if (typeof v !== "string" || !isUuid(v)) {
          return { status: 400, body: { error: `${key} must be an id` } };
        }
        collected[key] = v;
      }
      // Till-drop destinations: the bank accounts a cashier may move till
      // cash into. An empty list (or clearing the key) disables drops.
      if (input.depositAccountIds !== undefined) {
        const v = input.depositAccountIds;
        if (v === null || (Array.isArray(v) && v.length === 0)) {
          delete collected.depositAccountIds;
        } else {
          if (!Array.isArray(v)) {
            return {
              status: 400,
              body: { error: "Till-drop bank accounts must be a list of account ids" },
            };
          }
          const ids = [...new Set(v)];
          for (const id of ids) {
            if (typeof id !== "string" || !isUuid(id)) {
              return {
                status: 400,
                body: { error: "Till-drop bank accounts must be a list of account ids" },
              };
            }
          }
          collected.depositAccountIds = ids;
        }
      }
      if (typeof collected.walkInCustomerId === "string") {
        const party = await tx.execute(
          sql`
          select p.id
            from parties p
            join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active
           where p.org_id = ${orgId} and p.id = ${collected.walkInCustomerId} and p.is_active
           limit 1`,
          "objects",
        );
        if (!party[0]) {
          return {
            status: 400,
            body: {
              error: "walkInCustomerId must be an active customer of this organization",
            },
          };
        }
      }
      const tenderAccountIds = CASH_SALES_SETTING_KEYS.filter(
        (key) => key !== "walkInCustomerId" && key !== "depositAccountIds",
      )
        .map((key) => collected[key])
        .filter((id): id is string => typeof id === "string");
      if (tenderAccountIds.length > 0) {
        const found = await tx.execute<{ id: string; type: string }>(
          sql`
          select id, type from accounts
           where org_id = ${orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(tenderAccountIds)}::jsonb)::uuid)
             and is_active and not is_summary`,
          "objects",
        );
        const byId = new Map(found.map((row) => [row.id, row.type]));
        for (const key of CASH_SALES_SETTING_KEYS) {
          if (key === "walkInCustomerId" || key === "depositAccountIds") continue;
          const accountId = collected[key];
          if (typeof accountId !== "string") continue;
          const type = byId.get(accountId);
          if (!type) {
            return {
              status: 400,
              body: { error: `${key} must be an active, non-summary account of this organization` },
            };
          }
          if (type === "asset_receivable" || type === "liability_payable") {
            return {
              status: 400,
              body: {
                error: `${key} cannot be a receivable or payable control account — tenders settle into clearing or bank accounts`,
              },
            };
          }
        }
      }
      // Till-drop destinations take money to the bank: bank or asset
      // clearing only, active and postable — never receivables, payables,
      // or P&L accounts.
      const depositIds = Array.isArray(collected.depositAccountIds)
        ? (collected.depositAccountIds as unknown[]).filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      if (depositIds.length > 0) {
        const found = await tx.execute<{ id: string; type: string }>(
          sql`
          select id, type from accounts
           where org_id = ${orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(depositIds)}::jsonb)::uuid)
             and is_active and not is_summary`,
          "objects",
        );
        const byId = new Map(found.map((row) => [row.id, row.type]));
        for (const accountId of depositIds) {
          const type = byId.get(accountId);
          if (!type) {
            return {
              status: 400,
              body: {
                error:
                  "depositAccountIds must be active, non-summary accounts of this organization",
              },
            };
          }
          if (type !== "asset_bank" && type !== "asset_current_other") {
            return {
              status: 400,
              body: {
                error:
                  "depositAccountIds must be bank or asset clearing accounts — till drops move cash to the bank",
              },
            };
          }
        }
      }
      nextCashSales = collected as Record<string, string>;
    }

    // --- tenant default language (users without a personal locale inherit it) ---
    let nextDefaultLocale: string | undefined;
    if (body.defaultLocale !== undefined) {
      if (!isLocale(body.defaultLocale)) {
        return { status: 400, body: { error: "unsupported locale" } };
      }
      nextDefaultLocale = body.defaultLocale;
    }

    // --- fiscal year start month ---
    let nextStartMonth: number | undefined;
    if (body.fiscalYearStartMonth !== undefined) {
      const m = Number(body.fiscalYearStartMonth);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return { status: 400, body: { error: "fiscalYearStartMonth must be 1–12" } };
      }
      nextStartMonth = m;
    }

    // Assemble the settings jsonb (merge, don't clobber sibling keys like eft).
    const curStartMonth =
      typeof settings.fiscalYearStartMonth === "number" ? settings.fiscalYearStartMonth : 1;
    const startMonthChanged = nextStartMonth !== undefined && nextStartMonth !== curStartMonth;
    const nextSettings = { ...settings } as Record<string, unknown>;
    let settingsChanged = false;
    if (nextStartMonth !== undefined && nextStartMonth !== curStartMonth) {
      nextSettings.fiscalYearStartMonth = nextStartMonth;
      changes.fiscalYearStartMonth = [curStartMonth, nextStartMonth];
      settingsChanged = true;
    }
    if (body.taxFramework !== undefined) {
      if (body.taxFramework !== "asc740" && body.taxFramework !== "ias12") {
        return { status: 400, body: { error: "taxFramework must be asc740 or ias12" } };
      }
      const curFramework = settings.taxFramework === "ias12" ? "ias12" : "asc740";
      if (body.taxFramework !== curFramework) {
        nextSettings.taxFramework = body.taxFramework;
        changes.taxFramework = [curFramework, body.taxFramework];
        settingsChanged = true;
      }
    }
    if (body.reportingFramework !== undefined) {
      if (body.reportingFramework !== "us_gaap" && body.reportingFramework !== "ifrs") {
        return { status: 400, body: { error: "reportingFramework must be us_gaap or ifrs" } };
      }
      const curReportingFramework =
        settings.reportingFramework === "ifrs" || settings.reportingFramework === "us_gaap"
          ? settings.reportingFramework
          : null;
      if (body.reportingFramework !== curReportingFramework) {
        // Lease classifications and NRV write-downs snapshot the policy that
        // produced their accounting evidence. Once either evidence stream
        // exists, changing the org policy without a prospective migration
        // would make a later read appear to reinterpret committed history.
        if (curReportingFramework !== null) {
          const evidence = await tx.execute<{
            leaseEvidence: boolean;
            inventoryEvidence: boolean;
          }>(
            sql`
            select exists (
                     select 1 from lease_agreements where org_id = ${orgId}
                   ) as "leaseEvidence",
                   exists (
                     select 1 from inventory_writedowns where org_id = ${orgId}
                   ) as "inventoryEvidence"`,
            "objects",
          );
          if (evidence[0]?.leaseEvidence || evidence[0]?.inventoryEvidence) {
            return {
              status: 409,
              body: {
                error: "reporting-framework-locked",
                message:
                  "Cannot change the reporting framework after lease or inventory NRV evidence exists.",
              },
            };
          }
        }
        nextSettings.reportingFramework = body.reportingFramework;
        changes.reportingFramework = [curReportingFramework, body.reportingFramework];
        settingsChanged = true;
      }
    }
    if (nextControl !== undefined) {
      const curControl = (settings.controlAccounts ?? {}) as Record<string, string>;
      if (JSON.stringify(curControl) !== JSON.stringify(nextControl)) {
        nextSettings.controlAccounts = nextControl;
        changes.controlAccounts = [curControl, nextControl];
        settingsChanged = true;
      }
    }
    if (nextCashSales !== undefined) {
      const curCashSales = (settings.cashSales ?? {}) as Record<string, string>;
      if (JSON.stringify(curCashSales) !== JSON.stringify(nextCashSales)) {
        nextSettings.cashSales = nextCashSales;
        changes.cashSales = [curCashSales, nextCashSales];
        settingsChanged = true;
      }
    }
    // --- company default payment terms (invoices and bills fall back to
    // these when the counterparty names none) ---
    if (body.billing !== undefined) {
      if (
        typeof body.billing !== "object" ||
        body.billing === null ||
        Array.isArray(body.billing)
      ) {
        return { status: 400, body: { error: "billing must be an object" } };
      }
      const billingInput = body.billing as Record<string, unknown>;
      const unknownBilling = Object.keys(billingInput).filter(
        (key) => !(BILLING_SETTING_KEYS as readonly string[]).includes(key),
      );
      if (unknownBilling.length > 0) {
        return {
          status: 400,
          body: { error: `unknown billing setting: ${unknownBilling.join(", ")}` },
        };
      }
      let nextBilling: BillingSettings | undefined;
      if (billingInput.defaultPaymentTermsId !== undefined) {
        const rawTerms = billingInput.defaultPaymentTermsId;
        if (rawTerms !== null) {
          if (typeof rawTerms !== "string" || !isUuid(rawTerms)) {
            return {
              status: 400,
              body: { error: "billing.defaultPaymentTermsId must be a payment-terms id or null" },
            };
          }
          const terms = (
            await tx.execute<{ name: string; isActive: boolean }>(
              sql`
            select name, is_active as "isActive" from payment_terms
             where org_id = ${orgId} and id = ${rawTerms}`,
              "objects",
            )
          )[0];
          if (!terms) {
            return {
              status: 400,
              body: {
                error: `billing.defaultPaymentTermsId ${rawTerms} does not exist in this organization — choose terms from Setup → Payment terms`,
              },
            };
          }
          if (!terms.isActive) {
            return {
              status: 422,
              body: {
                error: `payment terms "${terms.name}" is inactive — activate it in Setup → Payment terms or choose active terms`,
              },
            };
          }
        }
        nextBilling = { defaultPaymentTermsId: rawTerms };
      }
      if (nextBilling !== undefined) {
        const curBilling = readBillingSettings(settings.billing);
        // Clearing the default removes the key rather than storing an
        // explicit null, so readers see "no default" either way. An absent
        // id and an explicit null are the same state: no change recorded.
        const curId = curBilling.defaultPaymentTermsId;
        const nextId = nextBilling.defaultPaymentTermsId;
        if (curId !== nextId) {
          if (nextId === null) delete nextSettings.billing;
          else nextSettings.billing = nextBilling;
          changes.billing = [curBilling, nextId === null ? null : nextBilling];
          settingsChanged = true;
        }
      }
    }
    const curDefaultLocale = isLocale(settings.defaultLocale)
      ? settings.defaultLocale
      : DEFAULT_LOCALE;
    if (nextDefaultLocale !== undefined && nextDefaultLocale !== curDefaultLocale) {
      nextSettings.defaultLocale = nextDefaultLocale;
      changes.defaultLocale = [curDefaultLocale, nextDefaultLocale];
      settingsChanged = true;
    }
    // --- business time zone (IANA; aliases canonicalized at save) ---
    // The zone dates every business day, so an unknown value refuses by
    // name instead of accruing UTC days. Clearing (null/"") returns the
    // org to the UTC default. Changing it needs no activity lock: business
    // dates are computed live from this key, and already-posted rows keep
    // the dates they were posted with.
    if (body.timeZone !== undefined) {
      if (
        body.timeZone === null ||
        (typeof body.timeZone === "string" && body.timeZone.trim() === "")
      ) {
        if (settings.timeZone !== undefined && settings.timeZone !== null) {
          const before = settings.timeZone;
          delete nextSettings.timeZone;
          changes.timeZone = [before, null];
          settingsChanged = true;
        }
      } else {
        const canonical = canonicalTimeZone(body.timeZone);
        if (!canonical) {
          return {
            status: 400,
            body: {
              error: `timeZone ${JSON.stringify(body.timeZone) ?? "null"} is not a known IANA time zone`,
            },
          };
        }
        if (canonical !== canonicalTimeZone(settings.timeZone)) {
          nextSettings.timeZone = canonical;
          changes.timeZone = [settings.timeZone ?? null, canonical];
          settingsChanged = true;
        }
      }
    }
    // --- financial report PDF style (formal GAAP / modern branded) ---
    if (body.reportPdfStyle !== undefined) {
      const style = body.reportPdfStyle === "formal" ? "formal" : "modern";
      const curStyle = settings.reportPdfStyle === "formal" ? "formal" : "modern";
      if (style !== curStyle) {
        nextSettings.reportPdfStyle = style;
        changes.reportPdfStyle = [curStyle, style];
        settingsChanged = true;
      }
    }
    // --- fair value range policy (rev-rec allocation review: warn | off) ---
    // The policy lives on Company Settings, but it belongs to Revenue
    // Recognition. Turning that switch off must refuse a new write; the stored
    // value stays so turning the feature back on restores the same review rule.
    if (body.fairValueRangePolicy !== undefined) {
      if (body.fairValueRangePolicy !== "warn" && body.fairValueRangePolicy !== "off") {
        return { status: 400, body: { error: "fairValueRangePolicy must be 'warn' or 'off'" } };
      }
      const curRevenue = (settings.revenue ?? {}) as Record<string, unknown>;
      const curPolicy = curRevenue.fairValueRangePolicy === "off" ? "off" : "warn";
      if (body.fairValueRangePolicy !== curPolicy) {
        nextSettings.revenue = {
          ...curRevenue,
          fairValueRangePolicy: body.fairValueRangePolicy,
        };
        changes.fairValueRangePolicy = [curPolicy, body.fairValueRangePolicy];
        settingsChanged = true;
      }
    }
    // --- contract creation (scoped revenue contracts: first billing | booking) ---
    // When scoped contracts turn off the stored choice stays, so turning them
    // back on restores the same booking behavior instead of a blank control.
    if (body.contractCreation !== undefined) {
      if (body.contractCreation !== "first_billing" && body.contractCreation !== "booking") {
        return {
          status: 400,
          body: { error: "contractCreation must be 'first_billing' or 'booking'" },
        };
      }
      const curRevenue = (settings.revenue ?? {}) as Record<string, unknown>;
      const curCreation = curRevenue.contractCreation === "booking" ? "booking" : "first_billing";
      if (body.contractCreation !== curCreation) {
        nextSettings.revenue = {
          ...curRevenue,
          contractCreation: body.contractCreation,
        };
        changes.contractCreation = [curCreation, body.contractCreation];
        settingsChanged = true;
      }
    }
    if (body.saasMetrics !== undefined) {
      const candidate = body.saasMetrics;
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return { status: 400, body: { error: "saasMetrics must be an object" } };
      }
      const supplied = candidate as Record<string, unknown>;
      const evergreenBookingMonths = supplied.evergreenBookingMonths;
      const billingsUsePreTaxSubtotal = supplied.billingsUsePreTaxSubtotal;
      const customerCreditsReduceBillings = supplied.customerCreditsReduceBillings;
      if (
        typeof evergreenBookingMonths !== "string" ||
        !/^[1-9]\d*$/.test(evergreenBookingMonths)
      ) {
        return {
          status: 400,
          body: { error: "evergreenBookingMonths must be a positive whole number of months" },
        };
      }
      if (typeof billingsUsePreTaxSubtotal !== "boolean") {
        return { status: 400, body: { error: "billingsUsePreTaxSubtotal must be a boolean" } };
      }
      if (typeof customerCreditsReduceBillings !== "boolean") {
        return { status: 400, body: { error: "customerCreditsReduceBillings must be a boolean" } };
      }
      const currentValue = settings.saasMetrics;
      const current =
        currentValue !== null && typeof currentValue === "object" && !Array.isArray(currentValue)
          ? (currentValue as Record<string, unknown>)
          : {};
      const before = {
        evergreenBookingMonths: current.evergreenBookingMonths ?? "12",
        billingsUsePreTaxSubtotal: current.billingsUsePreTaxSubtotal ?? true,
        customerCreditsReduceBillings: current.customerCreditsReduceBillings ?? true,
      };
      const next = {
        evergreenBookingMonths,
        billingsUsePreTaxSubtotal,
        customerCreditsReduceBillings,
      };
      if (JSON.stringify(before) !== JSON.stringify(next)) {
        nextSettings.saasMetrics = next;
        changes.saasMetrics = [before, next];
        settingsChanged = true;
      }
    }
    // --- direct receivable/payable postings (journals and deposits) ---
    // Whether a manual journal or deposit line on a receivable or payable
    // account that names no customer or vendor posts with a warning or is
    // refused at posting. It gates new postings only; posted history is
    // never re-evaluated. Absent reads as "warn".
    if (body.partylessControlPolicy !== undefined) {
      if (
        !PARTYLESS_CONTROL_POLICIES.includes(body.partylessControlPolicy as PartylessControlPolicy)
      ) {
        return {
          status: 400,
          body: { error: "partylessControlPolicy must be 'warn' or 'refuse'" },
        };
      }
      const curLedger = (settings.ledger ?? {}) as Record<string, unknown>;
      const curPolicy = parsePartylessControlPolicy(curLedger.partylessControlPolicy);
      if (body.partylessControlPolicy !== curPolicy) {
        nextSettings.ledger = { ...curLedger, partylessControlPolicy: body.partylessControlPolicy };
        changes.partylessControlPolicy = [curPolicy, body.partylessControlPolicy];
        settingsChanged = true;
      }
    }
    for (const { key, value } of identitySettings) {
      const before =
        key === "companyAddress" ? readCompanyAddress(settings[key]) : (settings[key] ?? null);
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      if (value === null) delete nextSettings[key];
      else nextSettings[key] = value;
      changes[key] = [before, value];
      settingsChanged = true;
    }
    if (settingsChanged) {
      sets.push(sql`settings = ${JSON.stringify(nextSettings)}::jsonb`);
    }

    if (sets.length === 0) {
      return { status: 200, body: { ok: true, changed: false } };
    }

    // Persist org fields (+ settings) and, when the fiscal start moved, re-derive
    // every period. Audit evidence is the final statement in this SAME
    // transaction, so its failure rolls back org, calendar, and period changes.
    const effectiveStart = nextStartMonth ?? curStartMonth;

    if (startMonthChanged) {
      // Lock the target calendar and its periods before inspecting activity.
      // New journals/locks must acquire a foreign-key key-share lock on one of
      // these rows, so they cannot race the eligibility decision. Existing
      // lock and journal rows are locked below so close/post status changes are
      // equally fenced until this transaction commits.
      const calendar = await tx.execute<{ id: string }>(
        sql`
        select id
          from fiscal_calendars
         where org_id = ${orgId} and is_default and is_active
         for update`,
        "objects",
      );
      const calendarId = calendar[0]?.id;
      if (!calendarId) {
        return {
          status: 409,
          body: {
            error: "fiscal-calendar-not-found",
            message: "An active default fiscal calendar is required.",
          },
        };
      }

      await tx.execute(sql`
        select id
          from accounting_periods
         where org_id = ${orgId} and fiscal_calendar_id = ${calendarId}
         for update`);

      // Established calendars can contain millions of journals. Refuse them
      // with index-backed existence probes before taking row locks; only a
      // candidate fresh calendar reaches the concurrency fence below.
      const activity = await tx.execute<{
        posted: boolean;
        closed: boolean;
      }>(
        sql`
        select exists (
                 select 1
                   from journal_entries entry
                   join accounting_periods period
                     on period.org_id = entry.org_id
                    and period.id = entry.period_id
                  where period.org_id = ${orgId}
                    and period.fiscal_calendar_id = ${calendarId}
                    and entry.status in ('posted', 'reversed')
                  limit 1
               ) as posted,
               exists (
                 select 1
                   from period_locks period_lock
                   join accounting_periods period
                     on period.org_id = period_lock.org_id
                    and period.id = period_lock.period_id
                  where period.org_id = ${orgId}
                    and period.fiscal_calendar_id = ${calendarId}
                    and (
                      period_lock.state <> 'open'
                      or period_lock.reopen_expires_at <= now()
                    )
                  limit 1
               ) as closed`,
        "objects",
      );
      if (activity[0]?.posted || activity[0]?.closed) {
        return fiscalCalendarLockedResponse();
      }

      const periodLocks = await tx.execute<{
        state: string;
        reopenExpired: boolean;
      }>(
        sql`
        select period_lock.state,
               period_lock.reopen_expires_at <= now() as "reopenExpired"
          from period_locks period_lock
          join accounting_periods period
            on period.org_id = period_lock.org_id
           and period.id = period_lock.period_id
         where period.org_id = ${orgId}
           and period.fiscal_calendar_id = ${calendarId}
         for update of period_lock`,
        "objects",
      );
      const calendarClosed = periodLocks.some(
        (periodLock) => periodLock.state !== "open" || periodLock.reopenExpired,
      );

      const journals = await tx.execute<{ status: string }>(
        sql`
        select entry.status
          from journal_entries entry
          join accounting_periods period
            on period.org_id = entry.org_id
           and period.id = entry.period_id
         where period.org_id = ${orgId}
           and period.fiscal_calendar_id = ${calendarId}
         for update of entry`,
        "objects",
      );
      const calendarPosted = journals.some(
        (entry) => entry.status === "posted" || entry.status === "reversed",
      );

      if (calendarPosted || calendarClosed) {
        return fiscalCalendarLockedResponse();
      }
    }

    await tx.execute(sql`
    update orgs
       set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${actor.id}
     where id = ${orgId}`);

    if (startMonthChanged) {
      // Move existing labels outside the canonical range first so a calendar
      // rotation cannot collide with another period's old unique key.
      await tx.execute(periodDerivationStagingSql(orgId));
      await tx.execute(periodDerivationSql(orgId, effectiveStart));
      await tx.execute(sql`
      update fiscal_calendars
         set year_start_month = ${effectiveStart}, updated_at = now(), updated_by = ${actor.id}
       where org_id = ${orgId} and is_default`);
    }

    await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update',
            ${JSON.stringify(changes)}, ${actor.id})`);

    return {
      status: 200,
      body: {
        ok: true,
        changed: true,
        periodsRederived: startMonthChanged,
      },
    };
  });
}
