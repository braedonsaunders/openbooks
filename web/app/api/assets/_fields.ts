import "server-only";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import { cmp, normalizeMoney, toUnits } from "@openbooks/engine/src/money/money.ts";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { depreciationPeriodCount } from "@openbooks/engine/src/assets/depreciation-limits.ts";
import { isUuid } from "../../../lib/list-params";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import {
  findUnownedCustomReferences,
  loadFieldDefs,
  validateCustomValues,
} from "../../../lib/custom-fields";

/**
 * Shared fixed-asset field validation for POST /api/assets (create) and
 * PATCH /api/assets/[id] (edit).
 *
 * The RULES live here exactly once — what counts as a valid method, life,
 * rate, opening pair, account override, custom bag, or tax election must not
 * drift between create and edit. The WORDING stays per route: each validator
 * throws a stable FieldRefusal code, PATCH maps codes to its legacy
 * sentences, and POST returns the codes so the drawer can name the remedy.
 */
export class FieldRefusal extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, detail?: unknown) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export const ASSET_METHODS = [
  "straight_line",
  "declining_balance",
  "double_declining",
  "units_of_production",
  "manual",
] as const;
export type AssetMethod = (typeof ASSET_METHODS)[number];

export const ASSET_CONVENTIONS = ["full_month", "mid_month", "half_year"] as const;
export type AssetConvention = (typeof ASSET_CONVENTIONS)[number];

export function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
export function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length;
}

/** Exact numeric(19,4) money string, null when absent, or the refusal cause. */
export function moneyOrNull(v: unknown): string | null | "unreadable" | "too-wide" {
  if (v === null || v === undefined || v === "") return null;
  const exact = canonicalDecimal(v, 4);
  if (exact === null) return "unreadable";
  if (wholeDigits(exact) > 15) return "too-wide";
  try {
    return normalizeMoney(exact);
  } catch {
    return "too-wide";
  }
}

/** Undefined when absent (field untouched); null clears. Throws on invalid. */
export function parseAssetMethod(v: unknown): AssetMethod | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || !(ASSET_METHODS as readonly string[]).includes(v)) {
    throw new FieldRefusal("invalid_method");
  }
  return v as AssetMethod;
}

export function parseAssetConvention(v: unknown): AssetConvention | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || !(ASSET_CONVENTIONS as readonly string[]).includes(v)) {
    throw new FieldRefusal("invalid_convention");
  }
  return v as AssetConvention;
}

export function parseLifeMonths(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  try {
    return depreciationPeriodCount(v);
  } catch (error) {
    throw new FieldRefusal(
      "invalid_life",
      error instanceof Error ? error.message : undefined,
    );
  }
}

export function parseRatePercent(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const rate = canonicalDecimal(v, 4);
  if (rate === null) throw new FieldRefusal("invalid_rate");
  try {
    if (toUnits(rate) < 0n || cmp(rate, "10000") > 0) throw new Error("invalid rate");
  } catch {
    throw new FieldRefusal("invalid_rate");
  }
  return normalizeMoney(rate);
}

export function parseUnitsTotal(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const units = moneyOrNull(v);
  if (
    units === null ||
    units === "unreadable" ||
    units === "too-wide" ||
    cmp(units, "0") <= 0
  ) {
    throw new FieldRefusal("invalid_units");
  }
  return units;
}

export function parseOpeningAmount(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const amount = moneyOrNull(v);
  if (amount === null || amount === "unreadable" || amount === "too-wide") {
    throw new FieldRefusal("opening_invalid");
  }
  if (cmp(amount, "0") < 0) throw new FieldRefusal("opening_negative");
  return amount;
}

export function parseOpeningAsOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  const date = strOrNull(v);
  if (date !== null && !isIsoCalendarDate(date)) {
    throw new FieldRefusal("opening_as_of_invalid");
  }
  return date;
}

/** Both or neither: a carry-in amount without its measurement date (or the
 *  reverse) would silently reinterpret the depreciable basis. */
export function checkOpeningPair(
  accumulated: string | null,
  asOf: string | null,
): void {
  if ((accumulated === null) !== (asOf === null)) {
    throw new FieldRefusal("opening_pair_required");
  }
}

export function checkOpeningBasis(
  accumulated: string | null,
  cost: string,
  salvage: string,
): void {
  if (
    accumulated !== null &&
    toUnits(accumulated) > toUnits(cost) - toUnits(salvage)
  ) {
    throw new FieldRefusal("opening_exceeds_basis");
  }
}

export function checkOpeningMonth(
  accumulated: string | null,
  asOf: string | null,
  inServiceOn: string | null,
): void {
  if (
    accumulated !== null &&
    cmp(accumulated, "0") > 0 &&
    inServiceOn &&
    asOf &&
    asOf.slice(0, 7) < inServiceOn.slice(0, 7)
  ) {
    throw new FieldRefusal("opening_before_in_service");
  }
}

async function accountExists(
  exec: SqlExecutor,
  id: string,
  orgId: string,
  allowedSubsidiaryIds: readonly string[] | null,
): Promise<boolean> {
  const found = await exec.execute(
    sql`select 1 from accounts a
         where a.id = ${id} and a.org_id = ${orgId} and not a.is_summary
           ${assetAccountScopeSql(orgId, allowedSubsidiaryIds)}`,
  );
  return !!found.rows[0];
}

/** SQL scope shared by asset account pickers and submitted account overrides. */
export function assetAccountScopeSql(
  orgId: string,
  allowedSubsidiaryIds: readonly string[] | null,
) {
  if (allowedSubsidiaryIds === null) return sql``;
  const ids = `{${allowedSubsidiaryIds.join(",")}}`;
  return sql`and (
    a.subsidiary_id is null
    or a.subsidiary_id = any(${ids}::uuid[])
    or (a.subsidiary_include_children and exists (
      with recursive ancestors as (
        select id, parent_id from subsidiaries
         where org_id = ${orgId} and id = any(${ids}::uuid[])
        union
        select parent.id, parent.parent_id from subsidiaries parent
          join ancestors child on child.parent_id = parent.id
         where parent.org_id = ${orgId}
      ) select 1 from ancestors where id = a.subsidiary_id
    ))
  )`;
}

/**
 * Native GL account override: null clears back to the category default.
 * The code names the field so PATCH can keep its per-field sentences.
 */
export async function parseAccountOverride(
  exec: SqlExecutor,
  orgId: string,
  allowedSubsidiaryIds: readonly string[] | null,
  v: unknown,
  code: string,
): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  const candidate = strOrNull(v);
  if (candidate === null) return null;
  if (!isUuid(candidate) || !(await accountExists(exec, candidate, orgId, allowedSubsidiaryIds))) {
    throw new FieldRefusal(code);
  }
  return candidate.toLowerCase();
}

export async function parseDepreciationMethodId(
  exec: SqlExecutor,
  orgId: string,
  v: unknown,
): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  const candidate = strOrNull(v);
  if (candidate === null) return null;
  if (!isUuid(candidate)) throw new FieldRefusal("invalid_formula");
  const formula = await exec.execute(sql`
    select 1 from depreciation_methods
     where id = ${candidate} and org_id = ${orgId} and is_active`);
  if (!formula.rows[0]) throw new FieldRefusal("unknown_formula");
  return candidate;
}

export async function parseTaxDepreciation(
  exec: SqlExecutor,
  orgId: string,
  v: unknown,
): Promise<Record<string, Record<string, unknown>> | undefined> {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new FieldRefusal("tax_elections_invalid");
  }
  const clean: Record<string, Record<string, unknown>> = {};
  for (const [regime, raw] of Object.entries(v)) {
    if (
      !/^[a-z][a-z0-9_]{0,62}$/.test(regime) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      throw new FieldRefusal("tax_elections_invalid");
    }
    const businessUsePercent = moneyOrNull(
      (raw as Record<string, unknown>).businessUsePercent ?? "100",
    );
    const bonusPercent = moneyOrNull((raw as Record<string, unknown>).bonusPercent ?? "0");
    const section179 = moneyOrNull((raw as Record<string, unknown>).section179 ?? "0");
    if (
      businessUsePercent === null ||
      businessUsePercent === "unreadable" ||
      businessUsePercent === "too-wide" ||
      cmp(businessUsePercent, "0") < 0 ||
      cmp(businessUsePercent, "100") > 0
    ) {
      throw new FieldRefusal("tax_business_use_invalid");
    }
    if (
      bonusPercent === null ||
      bonusPercent === "unreadable" ||
      bonusPercent === "too-wide" ||
      cmp(bonusPercent, "0") < 0 ||
      cmp(bonusPercent, "100") > 0
    ) {
      throw new FieldRefusal("tax_bonus_invalid");
    }
    if (
      section179 === "unreadable" ||
      section179 === "too-wide" ||
      (section179 !== null && cmp(section179, "0") < 0)
    ) {
      throw new FieldRefusal("tax_section179_invalid");
    }
    const classCode = strOrNull((raw as Record<string, unknown>).classCode);
    if (classCode) {
      const valid = await exec.execute(sql`
        select 1 from tax_pool_classes
         where org_id = ${orgId} and regime = ${regime} and class_code = ${classCode} and is_active`);
      if (!valid.rows[0]) throw new FieldRefusal("tax_class_invalid");
    }
    clean[regime] = {
      classCode,
      businessUsePercent,
      bonusPercent,
      section179: section179 ?? "0",
    };
  }
  return clean;
}

/**
 * Full custom bag for create (nothing stored yet, so the submitted bag IS
 * the effective bag). PATCH merges against the locked row itself and calls
 * checkCustomReferences on the supplied subset.
 */
export async function parseCustomBag(
  orgId: string,
  v: unknown,
): Promise<Record<string, unknown>> {
  const bag =
    v === undefined ? {} : (v as Record<string, unknown> | null) ?? {};
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    throw new FieldRefusal("invalid_custom_fields");
  }
  const defs = await loadFieldDefs("fixed_assets");
  const validated = validateCustomValues(defs, bag);
  if (!validated.ok) {
    throw new FieldRefusal("invalid_custom_fields", validated.errors);
  }
  const unowned = await findUnownedCustomReferences(orgId, defs, validated.cleaned);
  if (unowned.length > 0) {
    throw new FieldRefusal("unknown_custom_reference", unowned[0]!.label);
  }
  return validated.cleaned;
}

/**
 * Reference-custom-values ownership gate shared by create (whole cleaned
 * bag) and edit (supplied subset only, so legacy bags cannot lock unrelated
 * edits). Throws unknown_custom_reference naming the offending field label.
 */
export async function checkCustomReferences(
  orgId: string,
  defs: Awaited<ReturnType<typeof loadFieldDefs>>,
  supplied: Record<string, unknown>,
): Promise<void> {
  const unowned = await findUnownedCustomReferences(orgId, defs, supplied);
  if (unowned.length > 0) {
    throw new FieldRefusal("unknown_custom_reference", unowned[0]!.label);
  }
}

export async function customFieldDefinitions() {
  return loadFieldDefs("fixed_assets");
}

export function cleanCustomValues(
  defs: Awaited<ReturnType<typeof loadFieldDefs>>,
  bag: Record<string, unknown>,
) {
  return validateCustomValues(defs, bag);
}
