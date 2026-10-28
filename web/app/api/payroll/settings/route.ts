import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import type { Authz } from "@/lib/authz";
import { uuidId } from "@/lib/api/json-schema";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { lockLedgerSetupFence } from "@openbooks/engine/organization/ledger-setup";
import {
  payrollSettings,
  seedPayrollComponents,
  statutoryHolidayPayEnabled,
} from "@openbooks/engine/payroll/run-setup";
import { PAYROLL_ACCOUNT_SETTING_KEYS } from "@openbooks/engine/payroll/settings-references";
import {
  NET_PAY_CLEARING_SETTINGS_KEY,
  parseNetPayClearingWindows,
  validateNetPayClearingChange,
} from "@openbooks/engine/payroll/net-pay-clearing";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { type PayrollSubsidiaryScope } from "@openbooks/engine/payroll/scope";
import {
  declaredRemittanceFrequencySettingsKeys,
  declaredRemittanceVendorSettingsKeys,
  installablePayrollCountries,
  installablePayrollPacks,
  packSlotState,
  PAYROLL_COUNTRY_PACKS,
  PayrollPackError,
  setPackSlotAccount,
  uninstallPayrollPack,
  remittanceFrequencyBand,
  remittanceScheduleForFrequencyKey,
} from "@openbooks/engine/payroll/packs";
import { assertValidPasswordExpression, pdfEncryptionAvailable } from "@openbooks/pdf";
import { payrollPaymentMethodSettings } from "@openbooks/engine/payroll/payment-method";
import { payrollSetupState } from "@openbooks/engine/payroll/readiness";
import { STUB_PASSWORD_TOKENS, stubPasswordPolicy } from "../../../../lib/payroll-outputs";
import { guardRootSubsidiaryScope } from "../../../../lib/authz";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import { isUuid } from "../../../../lib/list-params";
import { suppliedValue } from "../../../../lib/payroll-decimal-refusal";

const remittanceVendorFields = Object.fromEntries(
  declaredRemittanceVendorSettingsKeys().map((key) => [key, uuidId.nullable().optional()]),
);
const remittanceFrequencyFields = Object.fromEntries(
  declaredRemittanceFrequencySettingsKeys().map((key) => [
    key,
    z
      .string()
      .nullable()
      .optional()
      .superRefine((value, ctx) => {
        if (value == null) return;
        const schedule = remittanceScheduleForFrequencyKey(key);
        if (!schedule || !remittanceFrequencyBand(schedule, value)) {
          const valid =
            schedule?.frequencies.map((band) => band.frequency).join(", ") ?? "none declared";
          ctx.addIssue({ code: "custom", message: `${key} must be one of ${valid}` });
        }
      }),
  ]),
);
const typedPayrollSettingsSchema = z.looseObject({
  wageExpenseAccountId: uuidId.nullable().optional(),
  burdenExpenseAccountId: uuidId.nullable().optional(),
  netPayAccountId: uuidId.nullable().optional(),
  ...remittanceVendorFields,
  ...remittanceFrequencyFields,
  eftFallbackToCheque: z.boolean().optional(),
  supplementalTaxMethod: z.enum(["period_cumulative", "per_run"]).optional(),
  wagesTo: z.enum(["expense", "labor_clearing"]).optional(),
  t4Transmitter: z
    .strictObject({
      bn: z.string().nullable().optional(),
      transmitterNumber: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      contactName: z.string().nullable().optional(),
      contactEmail: z.string().nullable().optional(),
      contactPhone: z.string().nullable().optional(),
    })
    .optional(),
  stubPassword: z.strictObject({ enabled: z.boolean(), expression: z.string() }).optional(),
  countries: z
    .array(
      z
        .string()
        .refine(
          (country) => Object.hasOwn(PAYROLL_COUNTRY_PACKS, country),
          "country must be a declared payroll pack",
        ),
    )
    .optional(),
  statutoryHolidayPay: z.boolean().optional(),
  // Dated clearing accounts a pay run's net pay may settle to instead of a bank.
  netPaySettlementClearing: z
    .array(
      z.strictObject({
        id: uuidId,
        accountId: uuidId,
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        effectiveTo: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(100)
    .optional(),
  slotAccounts: z
    .record(
      z
        .string()
        .refine(
          (country) => Object.hasOwn(PAYROLL_COUNTRY_PACKS, country),
          "country must be a declared payroll pack",
        ),
      z.record(z.string(), uuidId.nullable()),
    )
    .optional(),
});
const installableCountry = z
  .string()
  .refine(
    (country) => installableCountries().includes(country),
    "country must name an installable payroll pack",
  );
export const packActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("seed-components"), country: installableCountry }),
  z.strictObject({ action: z.literal("install-pack"), country: installableCountry }),
  z.strictObject({
    action: z.literal("uninstall-pack"),
    country: z
      .string()
      .refine(
        (code) => Object.hasOwn(PAYROLL_COUNTRY_PACKS, code),
        "country must name an installed payroll pack",
      ),
  }),
]);

export const dynamic = "force-dynamic";

/**
 * Payroll org settings (orgs.settings.payroll) — the control accounts the
 * commit projection posts to, the wages destination, the CRA remittance
 * vendor, and the installed country packs. PUT merges into the payroll
 * subtree only (jsonb_set, same shape as the labor-costing route) so sibling
 * settings keys are never clobbered; keys absent from the body keep their
 * stored value. POST { action: 'seed-components' } installs the statutory
 * component set; POST { action: 'install-pack', country } seeds it AND
 * records the pack under settings.payroll.countries.
 */

// Generic (jurisdiction-free) account slots. Statutory liabilities are NOT
// here: those are pack-declared slots written onto the seeded components
// (see engine/src/payroll/packs.ts).
const ACCOUNT_KEYS = PAYROLL_ACCOUNT_SETTING_KEYS;

/**
 * `cogs` is allowed for the two WAGE/BURDEN keys and for nothing else.
 *
 * For a contractor or a manufacturer, direct labour IS cost of sales — that is
 * the basis of job costing and the model this product is built around. The
 * product's own seeded charts say so: web/lib/industries.ts types
 * "Direct Labor" as `cogs` in three industry charts (construction 5300,
 * 5000, manufacturing 5200) and "Manufacturing Overhead" as `cogs` too, which
 * is precisely a burden account. Refusing `cogs` here meant OpenBooks created
 * an account called Direct Labor, typed it cogs, and then refused to let
 * payroll post wages to it — a browser persona picked the account the product
 * had told it to use and got a 422. Forcing wages into "6000 Office Salaries"
 * instead would misstate gross margin for every construction tenant.
 *
 * NOT added to the liability keys: a payable is not a cost of sales. The
 * seeded charts agree — every payroll liability they create is
 * `liability_current_other`, which was already allowed, so this is the only
 * place the allow-lists and the seeded charts disagreed.
 * payroll-account-types.test.ts pins both halves of that.
 */
/** Operator-facing names for the account settings, used in every refusal. */
const ACCOUNT_KEY_LABELS: Record<(typeof ACCOUNT_KEYS)[number], string> = {
  wageExpenseAccountId: "Wage expense",
  burdenExpenseAccountId: "Employer burden expense",
  netPayAccountId: "Net pay payable",
};
const EXPENSE_REMEDY = "an expense or cost-of-sales account";
const LIABILITY_REMEDY = "a current liability account (payable or other current liability)";
const ACCOUNT_TYPE_REMEDY: Record<(typeof ACCOUNT_KEYS)[number], string> = {
  wageExpenseAccountId: EXPENSE_REMEDY,
  burdenExpenseAccountId: EXPENSE_REMEDY,
  netPayAccountId: `${LIABILITY_REMEDY}; net pay is cleared to the bank when the run's payment is recorded`,
};
const ACCOUNT_TYPES_BY_KEY: Record<(typeof ACCOUNT_KEYS)[number], readonly string[]> = {
  wageExpenseAccountId: ["expense", "expense_other", "expense_deferred", "cogs"],
  burdenExpenseAccountId: ["expense", "expense_other", "expense_deferred", "cogs"],
  netPayAccountId: ["liability_payable", "liability_current_other"],
};

/**
 * Payroll jurisdiction packs the org can install — the pack REGISTRY's own
 * `installable` declaration via installablePayrollCountries, never a second
 * list. (Kept as a local name so the call sites below read unchanged.)
 */
const installableCountries = installablePayrollCountries;

/**
 * Installable packs as the PERSON sees them: (country, name) pairs from the
 * same registry declaration. Served alongside the codes-only list because a
 * surface handed only codes has nothing to show but codes — which is how the
 * onboarding wizard rendered every pack past CA/US as a bare "GB"/"DE"/"FR".
 */
const installablePackPairs = installablePayrollPacks;

async function validatePayrollAccounts(
  orgId: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  const requested = ACCOUNT_KEYS.flatMap((key) => {
    const value = body[key];
    return value == null ? [] : [[key, value as string] as const];
  });
  if (requested.length === 0) return null;
  const rows = await db.execute<{
    id: string;
    type: string;
    isActive: boolean;
    isSummary: boolean;
    number: string | null;
    name: string;
  }>(
    sql`
    select id::text as id, type, is_active as "isActive", is_summary as "isSummary",
           number, name
      from accounts
     where org_id = ${orgId}
       and id in (${sql.join(
         requested.map(([, id]) => sql`${id}`),
         sql`, `,
       )})`,
    "objects",
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [key, id] of requested) {
    const row = byId.get(id);
    const field = ACCOUNT_KEY_LABELS[key];
    if (!row) {
      return NextResponse.json(
        {
          error: `${field}: the chosen account is not in this organization's chart of accounts — choose an active posting account`,
        },
        { status: 422 },
      );
    }
    const account = row.number ? `${row.number} · ${row.name}` : row.name;
    if (!row.isActive) {
      return NextResponse.json(
        {
          error: `${field}: ${account} is inactive — reactivate it in the chart of accounts or choose another account`,
        },
        { status: 422 },
      );
    }
    if (row.isSummary) {
      return NextResponse.json(
        {
          error: `${field}: ${account} is a summary account and cannot receive postings — choose one of its posting sub-accounts`,
        },
        { status: 422 },
      );
    }
    if (!ACCOUNT_TYPES_BY_KEY[key].includes(row.type)) {
      return NextResponse.json(
        {
          error: `${field}: ${account} has account type "${row.type.replace(/_/g, " ")}" — ${field} must be ${ACCOUNT_TYPE_REMEDY[key]}`,
        },
        { status: 422 },
      );
    }
  }
  return null;
}

async function validateRemittanceVendors(
  orgId: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  const keys = declaredRemittanceVendorSettingsKeys();
  const requested = keys.flatMap((key) => {
    const value = body[key];
    return value == null ? [] : [[key, value as string] as const];
  });
  if (requested.length === 0) return null;
  const rows = await db.execute<{
    id: string;
    partyActive: boolean;
    roleActive: boolean;
  }>(
    sql`
    select p.id::text as id, p.is_active as "partyActive", v.is_active as "roleActive"
      from parties p
      join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id
     where p.org_id = ${orgId}
       and p.id in (${sql.join(
         requested.map(([, id]) => sql`${id}`),
         sql`, `,
       )})`,
    "objects",
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [key, id] of requested) {
    const row = byId.get(id);
    if (!row || !row.partyActive || !row.roleActive) {
      return NextResponse.json(
        { error: `invalid ${key}: active vendor in this organization is required` },
        { status: 422 },
      );
    }
  }
  return null;
}

async function currentPayrollBlob(orgId: string, lock = false): Promise<Record<string, unknown>> {
  if (lock) await lockLedgerSetupFence(db, orgId, "exclusive");
  const r = await db.execute<{ p: Record<string, unknown> | null }>(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}${lock ? sql` for update` : sql``}`,
    "objects",
  );
  return r[0]?.p ?? {};
}

async function writePayrollBlob(
  orgId: string,
  actorId: string,
  before: Record<string, unknown>,
  settings: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}', ${JSON.stringify(settings)}::jsonb)
     where id = ${orgId}`);
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update',
            ${JSON.stringify({ before: { payroll: before }, after: { payroll: settings } })}, ${actorId})`);
}

async function currentSlotAccounts(
  orgId: string,
  slotAccounts: Record<string, Record<string, string | null>>,
): Promise<Record<string, Record<string, string | null>>> {
  const before: Record<string, Record<string, string | null>> = {};
  for (const [country, slots] of Object.entries(slotAccounts)) {
    const pack = PAYROLL_COUNTRY_PACKS[country];
    if (!pack) continue;
    before[country] = {};
    for (const slotKey of Object.keys(slots)) {
      const slot = pack.statutorySlots.find((candidate) => candidate.key === slotKey);
      if (!slot) continue;
      const componentCodes = `{${slot.components.map((component) => component.code).join(",")}}`;
      const row = await db.execute<{ accountId: string | null }>(
        sql`
        select liability_account_id::text as "accountId"
          from pay_components
         where org_id = ${orgId} and code = any(${componentCodes}::text[])
         order by liability_account_id nulls last
         limit 1`,
        "objects",
      );
      before[country][slotKey] = row[0]?.accountId ?? null;
    }
  }
  return before;
}

async function pickerOptions(orgId: string, allowedSubsidiaryIds?: PayrollSubsidiaryScope) {
  const [accounts, vendors] = await Promise.all([
    db.execute<{ id: string; number: string | null; name: string }>(
      sql`
      select id, number, name from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`,
      "objects",
    ),
    db.execute<{ id: string; name: string }>(
      sql`
      select p.id, p.display_name as name from parties p
       join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
       where p.org_id = ${orgId} and p.is_active
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null, { orgWideNull: true })}
       order by p.display_name`,
      "objects",
    ),
  ]);
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.number ? `${a.number} · ${a.name}` : a.name,
    })),
    vendors: vendors.map((v) => ({ id: v.id, label: v.name })),
  };
}

export const GET = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  handler: async ({ authz: gate }) => {
    const scopeDenied = await guardRootSubsidiaryScope(gate);
    if (scopeDenied) return scopeDenied;
    const [settings, blob, options] = await Promise.all([
      payrollSettings(gate.user.orgId, gate.allowedSubsidiaryIds),
      currentPayrollBlob(gate.user.orgId),
      pickerOptions(gate.user.orgId, gate.allowedSubsidiaryIds),
    ]);
    const installed = Array.isArray(blob.countries) ? blob.countries.map(String) : [];
    const [packs, stubPassword, encryptionAvailable, setup] = await Promise.all([
      packSlotState(gate.user.orgId, installed),
      stubPasswordPolicy(gate.user.orgId),
      pdfEncryptionAvailable(),
      // The setup wizard's step state — the same org-level checks the pay-run
      // readiness pre-flight performs, so the two surfaces cannot disagree.
      payrollSetupState(gate.user.orgId, gate.allowedSubsidiaryIds),
    ]);
    const paymentMethods = await payrollPaymentMethodSettings(gate.user.orgId);
    const statutoryHolidayPay = await statutoryHolidayPayEnabled(
      gate.user.orgId,
      undefined,
      gate.allowedSubsidiaryIds,
    );
    let netPaySettlementClearing;
    try {
      netPaySettlementClearing = parseNetPayClearingWindows(blob[NET_PAY_CLEARING_SETTINGS_KEY]);
    } catch (error) {
      if (error instanceof PayrollError) return apiErrorResponse(error, { safeStatus: 409 });
      throw error;
    }
    return NextResponse.json({
      settings,
      packs,
      stubPassword,
      encryptionAvailable,
      paymentMethods,
      setup,
      statutoryHolidayPay,
      netPaySettlementClearing,
      installable: installableCountries(),
      installablePacks: installablePackPairs(),
      ...options,
    });
  },
});

/** Preserve field, cause and remedy before the typed schema and before any write. */
function payrollSettingsShapeRefusal(body: Record<string, unknown>): string | null {
  const acceptedKeys = new Set<string>([
    ...ACCOUNT_KEYS,
    ...declaredRemittanceVendorSettingsKeys(),
    ...declaredRemittanceFrequencySettingsKeys(),
    "eftFallbackToCheque",
    "supplementalTaxMethod",
    "wagesTo",
    "t4Transmitter",
    "stubPassword",
    "countries",
    "statutoryHolidayPay",
    "slotAccounts",
    "netPaySettlementClearing",
  ]);
  const unknownKey = Object.keys(body).find((key) => !acceptedKeys.has(key));
  if (unknownKey) {
    const remedy =
      unknownKey === "craRemittanceFrequency"
        ? "set the CRA remitter type on its filing account in Payroll Setup → Filing accounts"
        : "remove the unknown key or use a setting declared by the payroll setup";
    return `unknown payroll setting "${unknownKey}" — ${remedy}`;
  }

  for (const key of ACCOUNT_KEYS) {
    if (!(key in body)) continue;
    const v = body[key] ?? null;
    // Same accept/refuse set as before, split causes: a non-string is not an
    // account reference at all, while a string that is not a uuid names a
    // value no picker could have produced.
    if (v !== null && typeof v !== "string") {
      return `invalid ${key}: must be an account id — got "${suppliedValue(v)}"; choose the account in Payroll setup → Accounts`;
    }
    if (v !== null && !isUuid(v)) {
      return `invalid ${key}: "${v}" is not an account id — choose the account in Payroll setup → Accounts`;
    }
  }
  // Statutory remittance vendors — exactly the settings keys the pack
  // declarations name (the CRA vendor, the Revenu Québec vendor for the CA
  // pack's QC-scoped components), never a literal list here.
  for (const vendorKey of declaredRemittanceVendorSettingsKeys()) {
    if (!(vendorKey in body)) continue;
    const party = body[vendorKey] ?? null;
    // Same accept/refuse set as before, split causes. The existence check
    // below ("active vendor in this organization is required") still owns the
    // unknown-but-well-formed id; these two own the malformed value.
    if (party !== null && typeof party !== "string") {
      return `invalid ${vendorKey}: must be a vendor id — got "${suppliedValue(party)}"; choose an active vendor in this organization`;
    }
    if (party !== null && !isUuid(party)) {
      return `invalid ${vendorKey}: "${party}" is not a vendor id — choose an active vendor in this organization`;
    }
  }
  // Destination remittance frequencies — exactly the settings keys the pack
  // schedules declare, each validated against its own schedule's bands (a
  // CRA remitter type is never a valid RQ frequency and vice versa). Null
  // clears back to the schedule default; anything else is refused at save
  // time rather than silently dating bills from the default.
  for (const frequencyKey of declaredRemittanceFrequencySettingsKeys()) {
    if (!(frequencyKey in body)) continue;
    const value = body[frequencyKey] ?? null;
    if (value === null) continue;
    const schedule = remittanceScheduleForFrequencyKey(frequencyKey);
    // Unreachable by construction: the key came off this very schedule list
    // (both helpers derive from allRemittanceSchedules in packs.ts), so the
    // find cannot miss. Fail closed without blaming the operator's value —
    // a missing schedule is a declaration inconsistency, not bad input.
    if (!schedule) {
      return `invalid ${frequencyKey}: no remittance schedule declares "${frequencyKey}", so "${suppliedValue(value)}" cannot be checked — no value can be accepted for this setting right now`;
    }
    const bands = schedule.frequencies.map((band) => `"${band.frequency}"`).join(", ");
    if (typeof value !== "string") {
      return `invalid ${frequencyKey}: must be a frequency name — got "${suppliedValue(value)}"; choose one of ${bands}`;
    }
    if (!remittanceFrequencyBand(schedule, value)) {
      return `invalid ${frequencyKey}: "${value}" is not a frequency of this schedule — valid frequencies are ${bands}; frequencies belong to one schedule only, so a value from another schedule is never valid here`;
    }
  }
  if ("eftFallbackToCheque" in body) {
    if (typeof body.eftFallbackToCheque !== "boolean") {
      return `invalid eftFallbackToCheque: must be true or false — got "${suppliedValue(body.eftFallbackToCheque)}"; pass true to fall back to a cheque when bank details are missing, or false to block the run instead`;
    }
  }
  if ("supplementalTaxMethod" in body) {
    if (
      body.supplementalTaxMethod !== "period_cumulative" &&
      body.supplementalTaxMethod !== "per_run"
    ) {
      return `invalid supplementalTaxMethod: must be "period_cumulative" or "per_run" — got "${suppliedValue(body.supplementalTaxMethod)}"; pass one of those values or omit supplementalTaxMethod to leave the setting unchanged`;
    }
  }
  if ("wagesTo" in body) {
    if (body.wagesTo !== "expense" && body.wagesTo !== "labor_clearing") {
      return `invalid wagesTo: must be "expense" or "labor_clearing" — got "${suppliedValue(body.wagesTo)}"; pass one of those values or omit wagesTo to leave the setting unchanged`;
    }
  }
  if ("t4Transmitter" in body) {
    const cfg = body.t4Transmitter;
    // Same accept/refuse set as before, split three ways: null, a list, and
    // anything else that is not an object refuse with their own cause.
    if (cfg === null) {
      return "invalid t4Transmitter: must be an object — got null; pass the transmitter details (bn, transmitterNumber, name, contactName, contactEmail, contactPhone) or omit it";
    }
    if (Array.isArray(cfg)) {
      return "invalid t4Transmitter: must be an object — got a list; pass the transmitter details (bn, transmitterNumber, name, contactName, contactEmail, contactPhone) or omit it";
    }
    if (typeof cfg !== "object") {
      return `invalid t4Transmitter: must be an object — got "${suppliedValue(cfg)}"; pass the transmitter details (bn, transmitterNumber, name, contactName, contactEmail, contactPhone) or omit it`;
    }
    const keys = ["bn", "transmitterNumber", "name", "contactName", "contactEmail", "contactPhone"];
    for (const key of keys) {
      const v = (cfg as Record<string, unknown>)[key];
      if (v != null && typeof v !== "string")
        return `invalid t4Transmitter.${key}: must be text — got "${suppliedValue(v)}"; pass a string, null, or omit it`;
    }
  }
  if ("countries" in body) {
    const countries = body.countries;
    // Same accept/refuse set as before, split causes: a non-list is not a
    // country selection at all, while a list names WHICH entry no pack
    // declares. The installed list comes from the pack registry itself —
    // never a literal list here, so a new pack is nameable the moment it
    // registers.
    if (!Array.isArray(countries)) {
      return `invalid countries: must be a list of installed country codes — got "${suppliedValue(countries)}"; pass the countries to install, or omit it`;
    }
    const unknown = countries.find((c) => !Object.hasOwn(PAYROLL_COUNTRY_PACKS, String(c)));
    if (unknown !== undefined) {
      const installed = Object.keys(PAYROLL_COUNTRY_PACKS).join(", ");
      return `invalid countries: "${suppliedValue(unknown)}" is not an installed payroll country — installed countries are: ${installed}; install the pack first (POST action "install-pack") or remove it`;
    }
  }
  if ("statutoryHolidayPay" in body) {
    if (typeof body.statutoryHolidayPay !== "boolean") {
      return `invalid statutoryHolidayPay: must be true or false — got "${suppliedValue(body.statutoryHolidayPay)}"; pass true to enable statutory holiday pay, or false to leave gross pay unchanged`;
    }
  }

  if ("stubPassword" in body) {
    const rawPolicy = body.stubPassword;
    // Same accept/refuse set as before, split three ways: null, a list, and
    // anything else that is not an object refuse with their own cause.
    if (rawPolicy === null) {
      return "invalid stubPassword: must be an object — got null; pass { enabled, expression } or omit it";
    }
    if (Array.isArray(rawPolicy)) {
      return "invalid stubPassword: must be an object — got a list; pass { enabled, expression } or omit it";
    }
    if (typeof rawPolicy !== "object") {
      return `invalid stubPassword: must be an object — got "${suppliedValue(rawPolicy)}"; pass { enabled, expression } or omit it`;
    }
    const policy = rawPolicy as Record<string, unknown>;
    if (typeof policy.enabled !== "boolean")
      return `invalid stubPassword.enabled: must be true or false — got "${suppliedValue(policy.enabled)}"; explicitly choose whether emailed pay stubs require encryption`;
    if (typeof policy.expression !== "string")
      return `invalid stubPassword.expression: must be text — got "${suppliedValue(policy.expression)}"; enter the password expression or empty text when encryption is disabled`;
  }
  if ("slotAccounts" in body) {
    const slotAccounts = body.slotAccounts;
    // Same accept/refuse set as before, split causes at the top level and
    // named by country and slot below — a caller sending a map cannot tell
    // which entry failed from a bare field name.
    if (slotAccounts === null) {
      return 'invalid slotAccounts: must be an object mapping each country to its slot accounts — got null; pass { "<country>": { "<slot>": "<accountId|null>" } } or omit it';
    }
    if (Array.isArray(slotAccounts)) {
      return 'invalid slotAccounts: must be an object mapping each country to its slot accounts — got a list; pass { "<country>": { "<slot>": "<accountId|null>" } } or omit it';
    }
    if (typeof slotAccounts !== "object") {
      return `invalid slotAccounts: must be an object mapping each country to its slot accounts — got "${suppliedValue(slotAccounts)}"; pass { "<country>": { "<slot>": "<accountId|null>" } } or omit it`;
    }
    for (const [country, slots] of Object.entries(slotAccounts as Record<string, unknown>)) {
      const pack = Object.hasOwn(PAYROLL_COUNTRY_PACKS, country)
        ? PAYROLL_COUNTRY_PACKS[country]
        : undefined;
      if (!pack) {
        const installed = Object.keys(PAYROLL_COUNTRY_PACKS).join(", ");
        return `invalid pack ${country}: no payroll pack is installed for "${country}" — installed countries are: ${installed}; install the pack first (POST action "install-pack") or remove the entry`;
      }
      if (slots === null) {
        return `invalid pack ${country}: slot accounts must be an object — got null; pass { "<slot>": "<accountId|null>" } for ${country} or remove the entry`;
      }
      if (Array.isArray(slots)) {
        return `invalid pack ${country}: slot accounts must be an object — got a list; pass { "<slot>": "<accountId|null>" } for ${country} or remove the entry`;
      }
      if (typeof slots !== "object") {
        return `invalid pack ${country}: slot accounts must be an object — got "${suppliedValue(slots)}"; pass { "<slot>": "<accountId|null>" } for ${country} or remove the entry`;
      }
      for (const [slotKey, accountId] of Object.entries(slots as Record<string, unknown>)) {
        if (!pack.statutorySlots.some((slot) => slot.key === slotKey)) {
          const declared = pack.statutorySlots.map((slot) => `"${slot.key}"`).join(", ");
          return `invalid slot ${country}/${slotKey}: no statutory slot "${slotKey}" is declared for "${country}" — declared slots are: ${declared}; map each declared slot to an account id or null`;
        }
        if (accountId !== null && typeof accountId !== "string") {
          return `invalid account for ${country}/${slotKey}: must be an account id or null — got "${suppliedValue(accountId)}"; choose the account in Payroll setup → Accounts, or pass null to clear it`;
        }
        if (accountId !== null && !isUuid(accountId)) {
          return `invalid account for ${country}/${slotKey}: "${accountId}" is not an account id — choose the account in Payroll setup → Accounts, or pass null to clear it`;
        }
      }
    }
  }
  return null;
}

export const payrollSettingsSchema = z
  .record(z.string(), z.unknown())
  .superRefine((body, ctx) => {
    const message = payrollSettingsShapeRefusal(body);
    if (message) ctx.addIssue({ code: "custom", message });
  })
  .pipe(typedPayrollSettingsSchema);

export async function savePayrollSettings(input: {
  authz: Authz;
  body: z.infer<typeof payrollSettingsSchema>;
}): Promise<Response> {
  const gate = input.authz;
  const body = input.body;
  const orgId = gate.user.orgId;
  return withOrgTransaction(orgId, async () => {
    const settings: Record<string, unknown> = await currentPayrollBlob(orgId, true);
    const before = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
    const validated = await validatePayrollAccounts(orgId, body);
    if (validated instanceof NextResponse) return validated;
    for (const key of ACCOUNT_KEYS) {
      if (key in body) settings[key] = body[key] ?? null;
    }
    const vendorError = await validateRemittanceVendors(orgId, body);
    if (vendorError) return vendorError;
    for (const vendorKey of declaredRemittanceVendorSettingsKeys()) {
      if (vendorKey in body) settings[vendorKey] = body[vendorKey] ?? null;
    }
    for (const frequencyKey of declaredRemittanceFrequencySettingsKeys()) {
      if (frequencyKey in body) settings[frequencyKey] = body[frequencyKey] ?? null;
    }
    // The cheque safety net. On by default: a payroll that refuses to run
    // because one employee's void cheque has not been keyed yet fails everybody
    // else on the run. Turning it OFF is the deliberate strict posture — an
    // employee configured for EFT with no bank details blocks the run instead of
    // being paid on paper.
    if ("eftFallbackToCheque" in body) settings.eftFallbackToCheque = body.eftFallbackToCheque;
    if ("supplementalTaxMethod" in body)
      settings.supplementalTaxMethod = body.supplementalTaxMethod;
    if ("wagesTo" in body) settings.wagesTo = body.wagesTo;
    if ("t4Transmitter" in body) {
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(body.t4Transmitter!)) {
        if (typeof value === "string" && value.trim()) clean[key] = value.trim();
      }
      settings.t4Transmitter = clean;
    }
    // Emailed pay stubs carry wage data, so the org may require the PDF to be
    // encrypted. The password RULE is configuration (employers publish their own
    // to staff); it is validated here so a bad expression is refused at save
    // time rather than at stub-email time. No password is ever stored.
    if ("stubPassword" in body) {
      const rawPolicy = body.stubPassword;
      const policy = rawPolicy as Record<string, unknown>;
      const expression = typeof policy.expression === "string" ? policy.expression.trim() : "";
      const enabled = policy.enabled === true;
      if (enabled) {
        try {
          assertValidPasswordExpression(expression, STUB_PASSWORD_TOKENS);
        } catch (e) {
          return apiErrorResponse(e, { safeStatus: 422 });
        }
        if (!(await pdfEncryptionAvailable())) {
          return NextResponse.json(
            { error: "PDF encryption is unavailable on this server (qpdf is not installed)" },
            { status: 422 },
          );
        }
      }
      settings.stubPassword = { enabled, expression };
    }
    if ("countries" in body) settings.countries = [...new Set(body.countries!)];
    // Statutory holiday pay (engine/src/payroll/run.ts phase 2). Org-level
    // gate; default OFF for tenants that predate the feature because it changes
    // gross pay.
    if ("statutoryHolidayPay" in body) settings.statutoryHolidayPay = body.statutoryHolidayPay;
    // A re-pointed net-pay payable is re-checked against the stored designations too.
    if (
      "netPaySettlementClearing" in body ||
      ("netPayAccountId" in body && before[NET_PAY_CLEARING_SETTINGS_KEY] != null)
    ) {
      try {
        settings[NET_PAY_CLEARING_SETTINGS_KEY] = await validateNetPayClearingChange(db, {
          orgId,
          actorId: gate.user.id,
          before: before[NET_PAY_CLEARING_SETTINGS_KEY],
          after:
            "netPaySettlementClearing" in body
              ? body.netPaySettlementClearing
              : before[NET_PAY_CLEARING_SETTINGS_KEY],
          netPayAccountId:
            typeof settings.netPayAccountId === "string" ? settings.netPayAccountId : null,
        });
      } catch (error) {
        if (error instanceof PayrollError) return apiErrorResponse(error, { safeStatus: 422 });
        throw error;
      }
    }
    // NOTE: the pre-scoping `us` / `ca` rate blobs are not accepted here. A SUI
    // rate is experience-rated per filing account, FUTA is scoped per state and
    // year, and each province levies its own employer health tax. The upgrade
    // moves existing values into payroll_statutory_rates at each declared scope.

    // Pack-declared statutory slots: { [country]: { [slotKey]: accountId|null } }.
    // Writes land on the mapped components' liability accounts, never in the blob.
    if ("slotAccounts" in body) {
      const slotAccounts = body.slotAccounts!;
      const slotAccountsBefore = await currentSlotAccounts(
        orgId,
        slotAccounts as Record<string, Record<string, string | null>>,
      );
      for (const [country, slots] of Object.entries(
        slotAccounts as Record<string, Record<string, string | null>>,
      )) {
        for (const [slotKey, accountId] of Object.entries(slots)) {
          await setPackSlotAccount(orgId, gate.user.id, country, slotKey, accountId);
        }
      }
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'pay_components', ${orgId}, 'update',
                ${JSON.stringify({ before: { payrollSlotAccounts: slotAccountsBefore }, after: { payrollSlotAccounts: body.slotAccounts } })}, ${gate.user.id})`);
    }

    await writePayrollBlob(orgId, gate.user.id, before, settings);
    return NextResponse.json({ ok: true });
  });
}

export const PUT = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  scope: "root",
  body: payrollSettingsSchema,
  opaque: {
    body: "The existing settings validator checks dynamic pack-declared values and fields.",
  },
  invalidBodyStatus: 422,
  handler: savePayrollSettings,
});

export async function performPayrollPackAction(input: {
  authz: Authz;
  body: z.infer<typeof packActionSchema>;
}): Promise<Response> {
  const gate = input.authz;
  const body = input.body;
  if (body.action === "seed-components") {
    // The pack names its own component set; the registry is the only
    // validator. The old `body.country === 'US' ? 'US' : 'CA'` cast turned
    // every unrecognised value — a typo, a pack nobody wrote — into Canada
    // and seeded CPP/EI for it.
    const country = String(body.country ?? "");
    if (!installableCountries().includes(country)) {
      return NextResponse.json({ error: "unknown country pack" }, { status: 422 });
    }
    return withOrgTransaction(gate.user.orgId, async () => {
      await seedPayrollComponents(
        gate.user.orgId,
        gate.user.id,
        country,
        gate.allowedSubsidiaryIds,
      );
      await db.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${gate.user.orgId}, 'pay_components', ${gate.user.orgId}, 'insert',
                  ${JSON.stringify({ before: null, after: { payrollPack: country } })}, ${gate.user.id})`);
      return NextResponse.json({ ok: true });
    });
  }
  if (body.action === "install-pack") {
    const country = String(body.country ?? "");
    if (!installableCountries().includes(country)) {
      return NextResponse.json({ error: "unknown country pack" }, { status: 422 });
    }
    // A pack = its statutory component set (the engine wiring) plus the pack
    // marker the setup workspace and wizard read back.
    return withOrgTransaction(gate.user.orgId, async () => {
      await seedPayrollComponents(
        gate.user.orgId,
        gate.user.id,
        country,
        gate.allowedSubsidiaryIds,
      );
      await db.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${gate.user.orgId}, 'pay_components', ${gate.user.orgId}, 'insert',
                  ${JSON.stringify({ before: null, after: { payrollPack: country } })}, ${gate.user.id})`);
      const settings = await currentPayrollBlob(gate.user.orgId, true);
      const before = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
      const countries = Array.isArray(settings.countries) ? settings.countries.map(String) : [];
      // A NEW payroll org (first pack, nothing decided yet) starts with
      // statutory holiday pay ON; an existing tenant's stubs must not change on
      // an upgrade or a second-pack install, so an absent key stays absent.
      if (countries.length === 0 && !("statutoryHolidayPay" in settings)) {
        settings.statutoryHolidayPay = true;
      }
      settings.countries = [...new Set([...countries, country])];
      await writePayrollBlob(gate.user.orgId, gate.user.id, before, settings);
      return NextResponse.json({ ok: true });
    });
  }
  if (body.action === "uninstall-pack") {
    const country = String(body.country ?? "");
    if (!(country in PAYROLL_COUNTRY_PACKS)) {
      return NextResponse.json({ error: "unknown country pack" }, { status: 422 });
    }
    try {
      return await withOrgTransaction(gate.user.orgId, async () => {
        const before = await currentPayrollBlob(gate.user.orgId, true);
        const result = await uninstallPayrollPack(gate.user.orgId, gate.user.id, country);
        const after = await currentPayrollBlob(gate.user.orgId);
        await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${gate.user.orgId}, 'orgs', ${gate.user.orgId}, 'update',
                    ${JSON.stringify({ before: { payroll: before }, after: { payroll: after } })}, ${gate.user.id})`);
        return NextResponse.json({ ok: true, ...result });
      });
    } catch (error) {
      if (error instanceof PayrollPackError) {
        return apiErrorResponse(error, { safeStatus: 409 });
      }
      throw error;
    }
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export const POST = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  scope: "root",
  body: packActionSchema,
  handler: performPayrollPackAction,
});
