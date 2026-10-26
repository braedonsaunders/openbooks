import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { cmp } from "../money/money.ts";

/**
 * Placement readiness: the fields a fixed asset must carry before it can move
 * from draft to in service. The required-field rules mirror the depreciation
 * schedule build (depreciation-schedule-build.ts), and the effective values use
 * its precedence: book policy, then the asset, then the category default. A
 * refusal therefore names the fields the build would reject as missing. The
 * build remains the authority for other schedule refusals.
 */

export const ASSET_PLACEMENT_FIELDS = [
  "category_id",
  "acquisition_cost",
  "in_service_on",
  "useful_life_months",
  "depreciation_units_total",
  "opening_accumulated_depreciation",
  "opening_accumulated_as_of",
] as const;

export type AssetPlacementField = (typeof ASSET_PLACEMENT_FIELDS)[number];

/** English labels for API refusals. The drawer translates the field keys. */
export const ASSET_PLACEMENT_FIELD_LABELS: Record<AssetPlacementField, string> = {
  category_id: "Category",
  acquisition_cost: "Cost",
  in_service_on: "In service",
  useful_life_months: "Useful life (months)",
  depreciation_units_total: "Expected lifetime units",
  opening_accumulated_depreciation: "Opening accumulated",
  opening_accumulated_as_of: "Opening as of",
};

export interface AssetPlacementAsset {
  acquisitionCost: string | null;
  inServiceOn: string | null;
  depreciationMethod: string | null;
  depreciationMethodId: string | null;
  usefulLifeMonths: number | null;
  depreciationUnitsTotal: string | null;
  openingAccumulated: string | null;
  openingAsOf: string | null;
}

export interface AssetPlacementCategory {
  defaultMethod: string | null;
  defaultDepreciationMethodId: string | null;
  defaultLifeMonths: number | null;
}

/** The primary book's category policy, when one overrides the asset. */
export interface AssetPlacementPolicy {
  method: string | null;
  depreciationMethodId: string | null;
  lifeMonths: number | null;
  unitsTotal: string | null;
}

function isPositive(value: string | null): boolean {
  return value !== null && value.trim() !== "" && cmp(value, "0") > 0;
}

/**
 * Fields still missing for placement, in form order. Pure: the caller supplies
 * the category row and the primary-book policy row (or null for each).
 */
export function assetPlacementMissingFields(input: {
  asset: AssetPlacementAsset;
  category: AssetPlacementCategory | null;
  policy: AssetPlacementPolicy | null;
}): AssetPlacementField[] {
  const { asset, category, policy } = input;
  const missing: AssetPlacementField[] = [];
  if (!category) missing.push("category_id");

  // Effective values, in the build's precedence (depreciation-schedule-build.ts).
  const method =
    policy?.method ?? asset.depreciationMethod ?? category?.defaultMethod ?? "straight_line";
  const depreciationMethodId = policy
    ? policy.depreciationMethodId
    : asset.depreciationMethodId || asset.depreciationMethod
      ? asset.depreciationMethodId
      : (category?.defaultDepreciationMethodId ?? null);
  const lifeMonths =
    policy?.lifeMonths ?? asset.usefulLifeMonths ?? category?.defaultLifeMonths ?? null;
  const unitsTotal = policy?.unitsTotal != null ? policy.unitsTotal : asset.depreciationUnitsTotal;

  if (!isPositive(asset.acquisitionCost)) missing.push("acquisition_cost");
  if (!asset.inServiceOn) missing.push("in_service_on");
  if (
    (depreciationMethodId || (method !== "manual" && method !== "units_of_production")) &&
    !(lifeMonths !== null && lifeMonths > 0)
  ) {
    missing.push("useful_life_months");
  }
  if (method === "units_of_production" && !isPositive(unitsTotal)) {
    missing.push("depreciation_units_total");
  }

  // Both-or-neither: an opening amount without its as-of date (or the reverse)
  // cannot be scheduled.
  const hasAmount = asset.openingAccumulated !== null;
  const hasAsOf = asset.openingAsOf !== null;
  if (hasAmount && !hasAsOf) missing.push("opening_accumulated_as_of");
  if (hasAsOf && !hasAmount) missing.push("opening_accumulated_depreciation");
  return missing;
}

/**
 * Loads the category and the primary book's policy for the category, then
 * reports what is missing. Reads through the caller's runner so a save can
 * check its effective values inside its own transaction.
 */
export async function assetPlacementShortfall(
  runner: SqlExecutor,
  orgId: string,
  categoryId: string,
  asset: AssetPlacementAsset,
): Promise<AssetPlacementField[]> {
  const categoryRow = (
    await runner.execute<{
      default_method: string | null;
      default_depreciation_method_id: string | null;
      default_life_months: number | null;
    }>(
      sql`
      select default_method, default_depreciation_method_id, default_life_months
        from asset_categories where id = ${categoryId} and org_id = ${orgId}`,
      "objects",
    )
  )[0];
  const category: AssetPlacementCategory | null = categoryRow
    ? {
        defaultMethod: categoryRow.default_method,
        defaultDepreciationMethodId: categoryRow.default_depreciation_method_id,
        defaultLifeMonths: categoryRow.default_life_months,
      }
    : null;

  const bookId = await activePostingPrimaryBookId(orgId, runner);
  const policyRow = bookId
    ? (
        await runner.execute<{
          method: string | null;
          depreciation_method_id: string | null;
          life_months: number | null;
          units_total: string | null;
        }>(
          sql`
          select method, depreciation_method_id, life_months, units_total
            from depreciation_book_policies
           where org_id = ${orgId} and book_id = ${bookId} and category_id = ${categoryId}
           limit 1`,
          "objects",
        )
      )[0]
    : undefined;
  const policy: AssetPlacementPolicy | null = policyRow
    ? {
        method: policyRow.method,
        depreciationMethodId: policyRow.depreciation_method_id,
        lifeMonths: policyRow.life_months,
        unitsTotal: policyRow.units_total != null ? String(policyRow.units_total) : null,
      }
    : null;

  return assetPlacementMissingFields({ asset, category, policy });
}
