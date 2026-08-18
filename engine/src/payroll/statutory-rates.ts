import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { cmp, mulDecimal, normalizeDecimal } from "../money.ts";
import { PAYROLL_COUNTRY_PACKS, PayrollPackError, payrollPack } from "./packs.ts";
import { CA_PACK_RATES } from "./canada/rates.ts";
import { US_PACK_RATES } from "./us/rates.ts";

/**
 * Statutory rates that are NOT constants — and where each one lives.
 *
 * Most of a pack's statutory arithmetic is published: T4127's brackets, Pub
 * 15-T's schedules, the CPP maximums. Those are pack CONSTANTS, versioned by
 * edition, and no tenant may edit them. A minority are not published at all,
 * or are published per employer or per region, and those are the ones that were
 * quietly turned into org-level blobs in `orgs.settings.payroll`:
 *
 *   - a state unemployment (SUI) rate is EXPERIENCE-RATED per employer ACCOUNT.
 *     A two-EIN employer in one state holds two accounts with two different
 *     rates, and an org-level `settings.payroll.us.sui.MI` can store one of
 *     them. The other one's premiums were wrong on every stub.
 *   - the FUTA credit reduction is published by USDOL PER STATE PER YEAR. A
 *     single org-level `futaRate` either over-accrues for the crews in a normal
 *     state or under-accrues for the crews in a credit-reduction state, and the
 *     Form 940 Schedule A reconciliation cannot be made to tie either way.
 *   - employer health levies are PER PROVINCE (Ontario's EHT, and BC/MB/NL's
 *     own levies at their own rates and exemptions). One org-wide rate can
 *     represent exactly one province.
 *
 * The fix is ONE mechanism, not three special cases. A pack declares, for each
 * statutory rate it cannot publish, the SCOPE the rate varies by — org-wide,
 * per region, or per filing account — and the tenant's values live at that
 * scope in `payroll_statutory_rates`. The engine reads a RESOLUTION, so no
 * calculation path knows where a number came from, and no jurisdiction's shape
 * leaks into the generic layer.
 *
 * Behaviour for a single-account, single-region org is deliberately unchanged:
 * a pack may declare a `legacyRows` reader for its pre-scoping blob, which is
 * consulted only when no row exists. That fallback is READ-ONLY — writes always
 * land on rows, so there is never a second writable source of truth for one
 * statutory number (see .local/handoff-rates.md).
 */

// ---------------------------------------------------------------------------
// Declaration types
// ---------------------------------------------------------------------------

/**
 * What a statutory rate varies BY. Required per slot, because the generic layer
 * cannot guess and the cost of guessing is wrong money on a return:
 *
 *   - `org`             — one value for the whole employer (rare, and to be
 *     justified: most "org-wide" statutory rates turn out to be regional).
 *   - `region`          — one value per province/state (a provincial levy, the
 *     FUTA credit reduction).
 *   - `sub_region`      — one value per taxing unit BELOW a region: a
 *     Pennsylvania municipality's Act 32 earned income tax rate, an Ohio
 *     municipal or school-district rate. These ARE published — by roughly 2,500
 *     separate authorities, revised annually, in a register no payroll system
 *     can carry as a constant without being wrong for whichever one changed
 *     after the release. Same word as `PayrollCertificate.scope` and
 *     `PayrollSubRegionLevy` use, deliberately: one vocabulary for one idea.
 *   - `filing_account`  — one value per registered ACCOUNT, because the rate is
 *     assigned to the registration rather than to the employer (an
 *     experience-rated SUI rate). A region-wide row is still allowed and is
 *     what a single-account employer keeps using.
 */
export type PayrollRateScope = "org" | "region" | "sub_region" | "filing_account";

export const PAYROLL_RATE_SCOPES: readonly PayrollRateScope[] = [
  "org", "region", "sub_region", "filing_account",
];

/** One number inside a rate slot, and the shape it is accepted in. */
export interface PayrollRateField {
  /** Key inside the stored value object. */
  key: string;
  /** What the agency calls it. */
  label: string;
  /**
   * How the number is written on the agency's own notice, which is how the
   * operator will type it:
   *   - `rate`    — a decimal fraction (0.027 for 2.7%);
   *   - `percent` — a percent number (1.95 for 1.95%);
   *   - `amount`  — money (a wage base, an exemption).
   * Stored canonically at `decimals`; never converted between forms, because a
   * silent ×100 is the classic payroll-rate defect.
   */
  kind: "rate" | "percent" | "amount";
  /** Canonical scale. Exact — money.ts refuses a value that loses precision. */
  decimals: number;
  /** Inclusive accepted range, as the same kind of number. */
  min: string;
  max: string;
  required: boolean;
  /** Field help for the setup surface's `?` popover. */
  help: string;
}

export interface PayrollStatutoryRateSlot {
  /** Stable key within the pack ("us_sui", "us_futa", "ca_eht"). */
  key: string;
  /** What the levy is called where the operator will look for it. */
  label: string;
  /** REQUIRED — see PayrollRateScope. */
  scope: PayrollRateScope;
  /** Component system_keys the resolved values drive, for traceability. */
  systemKeys: readonly string[];
  /**
   * For `filing_account` scope: the declared filing program type whose accounts
   * carry the rate (`us_state_sui`). Enforced at the write boundary, so a SUI
   * rate cannot be attached to an EIN.
   */
  programType?: string;
  /**
   * Regions the levy exists in, for `region`, `sub_region` and
   * `filing_account` scope. Absent = every region the pack knows. A region
   * outside the list is refused rather than accepted and ignored.
   */
  regions?: readonly string[];
  fields: readonly PayrollRateField[];
  /** The statute or publication the rate is assessed under. */
  citation: string;
  /** Why this cannot be a pack constant — shown to the operator, not implied. */
  variesBecause: string;
}

/** A value set recovered from a pack's pre-scoping org blob. */
export interface LegacyRateRow {
  slotKey: string;
  region: string | null;
  values: Record<string, string>;
}

export interface PayrollPackRates {
  country: string;
  slots: readonly PayrollStatutoryRateSlot[];
  /**
   * The pack's pre-scoping `orgs.settings.payroll` shape, read as a FALLBACK so
   * a tenant configured before scoping existed calculates byte-identically.
   * Declared by the pack that created the shape; the generic layer never parses
   * a jurisdiction's blob.
   */
  legacyRows?: (blob: Record<string, unknown>) => readonly LegacyRateRow[];
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The built-in declarations, authored in each pack's own rate module beside the
 * constants they sit next to — the same arrangement as `{us,canada}/filings.ts`
 * and destined for `PayrollCountryPack.statutoryRates` (.local/handoff-rates.md).
 */
const BUILT_INS: readonly PayrollPackRates[] = [CA_PACK_RATES, US_PACK_RATES];

const EXTRA = new Map<string, PayrollPackRates>();

export function declaredPackRates(): PayrollPackRates[] {
  return [...BUILT_INS, ...EXTRA.values()];
}

/** Register an out-of-tree pack's rate declaration. One per country. */
export function registerPackRates(declaration: PayrollPackRates): void {
  if (!declaration.country) {
    throw new PayrollPackError("a payroll rate declaration must name its country");
  }
  if (declaredPackRates().some((declared) => declared.country === declaration.country)) {
    throw new PayrollPackError(
      `payroll statutory rates for ${declaration.country} are already declared — a country has `
      + "exactly one rate declaration",
    );
  }
  const keys = declaration.slots.map((slot) => slot.key);
  if (new Set(keys).size !== keys.length) {
    throw new PayrollPackError(`the ${declaration.country} rate declaration repeats a slot key`);
  }
  EXTRA.set(declaration.country, declaration);
}

/** Remove a non-built-in registration (test isolation only). */
export function unregisterPackRates(country: string): void {
  EXTRA.delete(country);
}

/** A pack's rate declaration, or a refusal naming the packs that have one. */
export function packRates(country: string): PayrollPackRates {
  const declared = declaredPackRates().find((entry) => entry.country === country);
  if (!declared) {
    throw new PayrollPackError(
      `the ${country || "(unset)"} payroll pack declares no statutory rate slots — a pack must `
      + "declare which of its statutory rates are tenant-entered and at what scope. Declared for: "
      + (declaredPackRates().map((entry) => entry.country).join(", ") || "none"),
    );
  }
  return declared;
}

/** One slot, or a refusal listing what the pack declares. */
export function statutoryRateSlot(country: string, slotKey: string): PayrollStatutoryRateSlot {
  const pack = packRates(country);
  const slot = pack.slots.find((declared) => declared.key === slotKey);
  if (!slot) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares no "${slotKey}" statutory rate — it declares `
      + (pack.slots.map((declared) => declared.key).join(", ") || "none"),
    );
  }
  return slot;
}

/** Every installable pack must answer the question. Asserted by the tests. */
export function packsMissingRateDeclarations(): string[] {
  return Object.values(PAYROLL_COUNTRY_PACKS)
    .filter((pack) => pack.installable)
    .map((pack) => pack.country)
    .filter((country) => !declaredPackRates().some((entry) => entry.country === country));
}

// ---------------------------------------------------------------------------
// Values: canonicalization and refusal
// ---------------------------------------------------------------------------

/**
 * Compare two decimals of arbitrary declared scale exactly.
 *
 * `cmp` works in the ledger's four decimals, and a statutory rate legitimately
 * carries more (QPIP's employer rate is 0.00602). Scaling both sides by a
 * million through `mulDecimal` keeps every digit inside money.ts's exact
 * arithmetic — no float ever sees a rate.
 */
function compareRate(a: string, b: string): number {
  return cmp(mulDecimal("1000000", a), mulDecimal("1000000", b));
}

/**
 * Canonicalize a slot's values, or throw naming the field and the reason.
 * Unknown keys are refused rather than dropped: silently discarding a number an
 * operator typed is how a wage base goes missing.
 */
export function canonicalStatutoryRateValues(
  slot: PayrollStatutoryRateSlot,
  values: Record<string, unknown>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const key of Object.keys(values)) {
    if (!slot.fields.some((field) => field.key === key)) {
      throw new PayrollPackError(
        `"${slot.key}" declares no "${key}" value — it declares `
        + slot.fields.map((field) => field.key).join(", "),
      );
    }
  }
  for (const field of slot.fields) {
    const raw = values[field.key];
    const blank = raw == null || (typeof raw === "string" && raw.trim() === "");
    if (blank) {
      if (field.required) {
        throw new PayrollPackError(`${slot.label}: ${field.label} is required`);
      }
      continue;
    }
    let canonical: string;
    try {
      canonical = normalizeDecimal(raw as string | number, field.decimals);
    } catch (error) {
      throw new PayrollPackError(
        `${slot.label}: ${field.label} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (compareRate(canonical, field.min) < 0 || compareRate(canonical, field.max) > 0) {
      throw new PayrollPackError(
        `${slot.label}: ${field.label} must be between ${field.min} and ${field.max} `
        + `(${field.kind === "percent" ? "a percent" : field.kind === "rate" ? "a decimal rate" : "an amount"})`,
      );
    }
    clean[field.key] = canonical;
  }
  return clean;
}

/**
 * Validate a rate row against the pack's declaration — the API-boundary control
 * that replaces the CHECK constraints a DB cannot write, for exactly the reason
 * `filingAccountProblem` exists: the registry is open, so the declaration is
 * the single source of truth and the constraint lives with it.
 *
 * Returns the problem as a sentence, or null.
 */
export function statutoryRateProblem(input: {
  country: string;
  rateKey: string;
  region: string | null;
  subRegion?: string | null;
  filingAccountId: string | null;
  taxYear: number;
  /** The named filing account, when one is named, for the cross-checks. */
  account?: { country: string; programType: string; stateCode: string | null } | null;
}): string | null {
  let slot: PayrollStatutoryRateSlot;
  try {
    slot = statutoryRateSlot(input.country, input.rateKey);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) {
    return `a statutory rate is entered for one tax year — ${input.taxYear} is not a tax year`;
  }
  const hasRegion = input.region != null && input.region !== "";
  if (slot.scope === "org") {
    if (hasRegion) {
      return `${slot.label} is declared org-wide by the ${input.country} pack — it carries no `
        + "region. Remove the region, or declare the slot per region in the pack.";
    }
  } else {
    if (!hasRegion) {
      const { regions } = payrollPack(input.country);
      return `${slot.label} varies by ${regions.label} — name the ${regions.label} it applies to`;
    }
    const problem = regionProblem(input.country, slot, input.region!);
    if (problem) return problem;
  }
  const hasSubRegion = input.subRegion != null && input.subRegion !== "";
  if (slot.scope === "sub_region") {
    if (!hasSubRegion) {
      return `${slot.label} varies by taxing jurisdiction inside the ${payrollPack(input.country).regions.label}`
        + " — name the jurisdiction it applies to";
    }
  } else if (hasSubRegion) {
    return `${slot.label} is not assigned per sub-jurisdiction by the ${input.country} pack — `
      + "remove it, or declare the slot at sub_region scope.";
  }
  if (slot.scope !== "filing_account" && input.filingAccountId) {
    return `${slot.label} is not assigned per filing account by the ${input.country} pack — `
      + "it applies to every account. Remove the account, or declare the slot per account.";
  }
  if (input.filingAccountId) {
    const account = input.account;
    if (!account) return "the named payroll filing account does not exist";
    if (account.country !== input.country) {
      return `the named filing account files under ${account.country}, not ${input.country}`;
    }
    if (slot.programType && account.programType !== slot.programType) {
      return `${slot.label} is held by a ${slot.programType} account — the named account is a `
        + `${account.programType} account`;
    }
    if (hasRegion && account.stateCode != null && account.stateCode !== input.region) {
      return `the named account is registered for ${account.stateCode}, not ${input.region}`;
    }
  }
  return null;
}

function regionProblem(
  country: string,
  slot: PayrollStatutoryRateSlot,
  region: string,
): string | null {
  const { regions } = payrollPack(country);
  if (!regions.known.includes(region)) {
    return `unknown ${country} ${regions.label} "${region}"`;
  }
  if (slot.regions && !slot.regions.includes(region)) {
    return `${slot.label} is not levied in ${region} — the ${country} pack declares it for `
      + slot.regions.join(", ");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface StatutoryRateRow {
  id: string;
  country: string;
  rateKey: string;
  region: string | null;
  /** The taxing unit below the region, for `sub_region`-scoped slots. */
  subRegion?: string | null;
  filingAccountId: string | null;
  taxYear: number;
  values: Record<string, string>;
  /** Account number, when the row is account-scoped — for labelling. */
  accountNumber?: string | null;
  accountName?: string | null;
}

/** The org's configured rate rows, newest scope first for stable rendering. */
export async function listStatutoryRates(
  orgId: string,
  filter: { country?: string; taxYear?: number } = {},
): Promise<StatutoryRateRow[]> {
  const rows = (await db.execute(sql`
    select r.id, r.country, r.rate_key, r.region, r.sub_region, r.filing_account_id,
           r.tax_year, r.rate_values, fa.account_number, fa.name as account_name
      from payroll_statutory_rates r
      left join payroll_filing_accounts fa
        on fa.id = r.filing_account_id and fa.org_id = r.org_id
     where r.org_id = ${orgId}
       and (${filter.country ?? null}::text is null or r.country = ${filter.country ?? null})
       and (${filter.taxYear ?? null}::int is null or r.tax_year = ${filter.taxYear ?? null})
     order by r.country, r.rate_key, r.tax_year desc,
              r.region nulls first, r.sub_region nulls first, fa.account_number nulls first
  `)) as unknown as { rows: Record<string, unknown>[] };
  return rows.rows.map((row) => ({
    id: String(row.id),
    country: String(row.country),
    rateKey: String(row.rate_key),
    region: (row.region as string | null) ?? null,
    subRegion: (row.sub_region as string | null) ?? null,
    filingAccountId: (row.filing_account_id as string | null) ?? null,
    taxYear: Number(row.tax_year),
    values: (row.rate_values ?? {}) as Record<string, string>,
    accountNumber: (row.account_number as string | null) ?? null,
    accountName: (row.account_name as string | null) ?? null,
  }));
}

/**
 * Write one rate row, keyed by its scope point (country, slot, region, account,
 * tax year) so a second save of the same point is an UPDATE, never a duplicate
 * that would make the resolution ambiguous. Audited with before/after.
 */
export async function upsertStatutoryRate(input: {
  orgId: string;
  actorId: string;
  country: string;
  rateKey: string;
  region: string | null;
  subRegion?: string | null;
  filingAccountId: string | null;
  taxYear: number;
  values: Record<string, unknown>;
}): Promise<{ id: string; values: Record<string, string> }> {
  const slot = statutoryRateSlot(input.country, input.rateKey);
  const values = canonicalStatutoryRateValues(slot, input.values);
  const region = input.region === "" ? null : input.region;
  const subRegion = input.subRegion == null || input.subRegion === "" ? null : input.subRegion;
  const existing = (await db.execute(sql`
    select id, rate_values from payroll_statutory_rates
     where org_id = ${input.orgId} and country = ${input.country}
       and rate_key = ${input.rateKey} and tax_year = ${input.taxYear}
       and region is not distinct from ${region}
       and sub_region is not distinct from ${subRegion}
       and filing_account_id is not distinct from ${input.filingAccountId}
  `)) as unknown as { rows: { id: string; rate_values: Record<string, string> }[] };
  const before = existing.rows[0];
  const id = before?.id ?? randomUUID();
  if (before) {
    await db.execute(sql`
      update payroll_statutory_rates
         set rate_values = ${JSON.stringify(values)}::jsonb,
             updated_by = ${input.actorId}, updated_at = now()
       where org_id = ${input.orgId} and id = ${id}`);
  } else {
    await db.execute(sql`
      insert into payroll_statutory_rates
        (id, org_id, country, rate_key, region, sub_region, filing_account_id, tax_year,
         rate_values, created_by, updated_by)
      values (${id}, ${input.orgId}, ${input.country}, ${input.rateKey}, ${region}, ${subRegion},
              ${input.filingAccountId}, ${input.taxYear}, ${JSON.stringify(values)}::jsonb,
              ${input.actorId}, ${input.actorId})`);
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'payroll_statutory_rates', ${id}, ${before ? "update" : "insert"},
            ${JSON.stringify({
              country: input.country, rateKey: input.rateKey, region, subRegion,
              filingAccountId: input.filingAccountId, taxYear: input.taxYear,
              before: before?.rate_values ?? null, after: values,
            })}::jsonb, ${input.actorId})`);
  return { id, values };
}

/** Remove one rate row. Returns false when the row is not the org's. */
export async function deleteStatutoryRate(
  orgId: string,
  actorId: string,
  id: string,
): Promise<boolean> {
  const gone = (await db.execute(sql`
    delete from payroll_statutory_rates
     where org_id = ${orgId} and id = ${id}
    returning country, rate_key, region, sub_region, filing_account_id, tax_year, rate_values
  `)) as unknown as { rows: Record<string, unknown>[] };
  const row = gone.rows[0];
  if (!row) return false;
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'payroll_statutory_rates', ${id}, 'delete',
            ${JSON.stringify({ before: row, after: null })}::jsonb, ${actorId})`);
  return true;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Where a resolved value came from — reportable, never guessed at. */
export type StatutoryRateSource = "account" | "region" | "org" | "legacy";

export interface ResolvedStatutoryRate {
  slotKey: string;
  scope: PayrollRateScope;
  region: string | null;
  subRegion: string | null;
  filingAccountId: string | null;
  /** null when the values came from the pre-scoping blob (no year on it). */
  taxYear: number | null;
  values: Record<string, string>;
  source: StatutoryRateSource;
}

export interface StatutoryRateResolution {
  country: string;
  taxYear: number;
  slots: readonly PayrollStatutoryRateSlot[];
  /** Every stored row for the year, for the setup surface. */
  rows: readonly StatutoryRateRow[];
  /** Values from the pre-scoping blob, if the pack declares a reader. */
  legacy: readonly LegacyRateRow[];
  /**
   * The values in force for a slot at a scope point, or null when the employer
   * has configured none — never a substituted default, because a made-up
   * statutory rate is money nobody can trace.
   */
  resolve(
    slotKey: string,
    at?: { region?: string | null; subRegion?: string | null; filingAccountId?: string | null },
  ): ResolvedStatutoryRate | null;
  /** The same, values only. */
  values(
    slotKey: string,
    at?: { region?: string | null; subRegion?: string | null; filingAccountId?: string | null },
  ): Record<string, string> | null;
}

/**
 * Resolve one org's rate rows for one pack and one tax year.
 *
 * Specificity, most specific first:
 *   1. the row for this filing ACCOUNT (an experience rate belongs to the
 *      registration, so it beats anything region-wide);
 *   2. the region-wide row (or the org-wide row for an `org`-scoped slot) —
 *      which is exactly the single-account employer's configuration;
 *   3. the pack's pre-scoping blob, read-only, so a tenant that never touched
 *      the new surface calculates byte-identically to before.
 *
 * One resolution per run, passed down — never a query per employee.
 */
export async function resolveStatutoryRates(
  orgId: string,
  country: string,
  taxYear: number,
): Promise<StatutoryRateResolution> {
  const pack = packRates(country);
  const [rows, blobRes] = await Promise.all([
    listStatutoryRates(orgId, { country, taxYear }),
    db.execute(sql`select settings->'payroll' as p from orgs where id = ${orgId}`) as unknown as
      Promise<{ rows: { p: Record<string, unknown> | null }[] }>,
  ]);
  const legacy = pack.legacyRows?.(blobRes.rows[0]?.p ?? {}) ?? [];
  return buildResolution({ country, taxYear, pack, rows, legacy });
}

/** The pure half, so the specificity ladder is testable without a database. */
export function buildResolution(input: {
  country: string;
  taxYear: number;
  pack: PayrollPackRates;
  rows: readonly StatutoryRateRow[];
  legacy: readonly LegacyRateRow[];
}): StatutoryRateResolution {
  const { country, taxYear, pack, rows, legacy } = input;
  const resolve: StatutoryRateResolution["resolve"] = (slotKey, at = {}) => {
    const slot = statutoryRateSlot(country, slotKey);
    const region = slot.scope === "org" ? null : (at.region ?? null);
    const subRegion = slot.scope === "sub_region" ? (at.subRegion ?? null) : null;
    const accountId = at.filingAccountId ?? null;
    const scoped = rows.filter((row) =>
      row.rateKey === slotKey && row.taxYear === taxYear
      && (row.region ?? null) === region
      && (row.subRegion ?? null) === subRegion);
    if (accountId && slot.scope === "filing_account") {
      const mine = scoped.find((row) => row.filingAccountId === accountId);
      if (mine) {
        return {
          slotKey, scope: slot.scope, region, subRegion, filingAccountId: accountId,
          taxYear, values: mine.values, source: "account",
        };
      }
    }
    const wide = scoped.find((row) => row.filingAccountId == null);
    if (wide) {
      return {
        slotKey, scope: slot.scope, region, subRegion, filingAccountId: null, taxYear,
        values: wide.values, source: slot.scope === "org" ? "org" : "region",
      };
    }
    const fallback = legacy.find(
      (row) => row.slotKey === slotKey && (row.region ?? null) === region,
    );
    if (fallback && subRegion == null) {
      return {
        slotKey, scope: slot.scope, region, subRegion: null, filingAccountId: null,
        taxYear: null, values: fallback.values, source: "legacy",
      };
    }
    return null;
  };
  return {
    country, taxYear, slots: pack.slots, rows, legacy,
    resolve,
    values: (slotKey, at) => resolve(slotKey, at)?.values ?? null,
  };
}

// ---------------------------------------------------------------------------
// What is not configured yet
// ---------------------------------------------------------------------------

/** One scope point a run actually touches. */
export interface StatutoryRatePoint {
  region: string | null;
  subRegion?: string | null;
  filingAccountId: string | null;
  /** Employees at this point, for the readiness item. */
  employees?: readonly { partyId: string; name: string }[];
}

export interface UnconfiguredStatutoryRate {
  country: string;
  slotKey: string;
  label: string;
  scope: PayrollRateScope;
  region: string | null;
  subRegion: string | null;
  filingAccountId: string | null;
  employees: readonly { partyId: string; name: string }[];
  /** Sentence for the readiness item / setup check. */
  message: string;
}

/**
 * Slots with no resolvable values at points the run actually pays.
 *
 * ADVISORY by design (see the readiness call site): an employer with no SUI
 * registration in a state genuinely owes no SUI there, and refusing the payroll
 * would be wrong. What the product owes the operator is the sentence — "no
 * Michigan SUI rate is configured for EIN …RP0002, so no SUI is being accrued
 * for the people paid under it" — before the money leaves, not after.
 */
export function unconfiguredStatutoryRates(
  resolution: StatutoryRateResolution,
  points: readonly StatutoryRatePoint[],
): UnconfiguredStatutoryRate[] {
  const found: UnconfiguredStatutoryRate[] = [];
  const seen = new Set<string>();
  for (const slot of resolution.slots) {
    for (const point of points) {
      const region = slot.scope === "org" ? null : point.region;
      if (slot.scope !== "org" && !region) continue;
      if (slot.regions && region && !slot.regions.includes(region)) continue;
      const subRegion = slot.scope === "sub_region" ? (point.subRegion ?? null) : null;
      if (slot.scope === "sub_region" && !subRegion) continue;
      const accountId = slot.scope === "filing_account" ? point.filingAccountId : null;
      const key = `${slot.key}:${region ?? ""}:${subRegion ?? ""}:${accountId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (resolution.resolve(slot.key, { region, subRegion, filingAccountId: accountId })) continue;
      const where = [
        region ? region : null,
        subRegion ? subRegion : null,
        accountId ? "the assigned filing account" : null,
      ].filter(Boolean).join(" · ");
      found.push({
        country: resolution.country,
        slotKey: slot.key,
        label: slot.label,
        scope: slot.scope,
        region,
        subRegion,
        filingAccountId: accountId,
        employees: point.employees ?? [],
        message:
          `no ${slot.label} is configured for ${where || resolution.country} in `
          + `${resolution.taxYear} — nothing is being accrued for it`,
      });
    }
  }
  return found;
}
