import { cmp } from '@openbooks/engine/src/money.ts'

/**
 * Depreciation-basis edit control for the fixed-asset PATCH route.
 *
 * Once any depreciation has posted, the basis a schedule was computed from is
 * fixed: editing it would silently replan the unposted plan and reinterpret
 * the periods already posted. Corrections go through controlled adjustments
 * (impairment, revaluation, disposal), not an asset edit. These helpers are
 * the single decision point for that rule, so the 409 guard and its audit
 * entry cannot drift apart.
 */

/** The stored fixed_assets columns a schedule is computed from. */
export interface AssetDepreciationBasis {
  acquisition_cost: string
  salvage_value: string
  useful_life_months: number | null
  in_service_on: string | null
  depreciation_rate_percent: string | null
  depreciation_units_total: string | null
  depreciation_convention: string | null
  depreciation_method: string | null
  depreciation_method_id: string | null
}

/**
 * Validated request fields that participate in the schedule computation.
 * `undefined` means "not sent"; an explicit value (including a null clear)
 * is compared against the stored basis.
 */
export interface RequestedAssetBasis {
  cost?: string
  salvage?: string
  lifeMonths?: number | null
  inServiceOn?: string | null
  ratePercent?: string | null
  unitsTotal?: string | null
  convention?: string | null
  method?: string | null
  depreciationMethodId?: string | null
}

/** The basis after applying the request to the stored row. */
export function mergedAssetBasis(
  existing: AssetDepreciationBasis,
  requested: RequestedAssetBasis,
): AssetDepreciationBasis {
  return {
    acquisition_cost: requested.cost !== undefined ? requested.cost : existing.acquisition_cost,
    salvage_value: requested.salvage !== undefined ? requested.salvage : existing.salvage_value,
    useful_life_months: requested.lifeMonths !== undefined ? requested.lifeMonths : existing.useful_life_months,
    in_service_on: requested.inServiceOn !== undefined ? requested.inServiceOn : existing.in_service_on,
    depreciation_rate_percent: requested.ratePercent !== undefined ? requested.ratePercent : existing.depreciation_rate_percent,
    depreciation_units_total: requested.unitsTotal !== undefined ? requested.unitsTotal : existing.depreciation_units_total,
    depreciation_convention: requested.convention !== undefined ? requested.convention : existing.depreciation_convention,
    depreciation_method: requested.method !== undefined ? requested.method : existing.depreciation_method,
    depreciation_method_id: requested.depreciationMethodId !== undefined ? requested.depreciationMethodId : existing.depreciation_method_id,
  }
}

/** Exact decimal-string comparison; null participates as a value of its own. */
function exactChanged(next: string | null, stored: string | null): boolean {
  if (next === null || stored === null) return next !== stored
  return cmp(next, stored) !== 0
}

/**
 * Stored column names whose value the request would actually change. Money,
 * rates and unit totals compare exactly (scaled bigint units), never by string
 * form, so a resave of unchanged values is never a basis change.
 */
export function assetBasisChanges(
  existing: AssetDepreciationBasis,
  requested: RequestedAssetBasis,
): string[] {
  const next = mergedAssetBasis(existing, requested)
  const changes: string[] = []
  if (exactChanged(next.acquisition_cost, existing.acquisition_cost)) changes.push('acquisition_cost')
  if (exactChanged(next.salvage_value, existing.salvage_value)) changes.push('salvage_value')
  if (next.useful_life_months !== existing.useful_life_months) changes.push('useful_life_months')
  if (next.in_service_on !== existing.in_service_on) changes.push('in_service_on')
  if (exactChanged(next.depreciation_rate_percent, existing.depreciation_rate_percent)) changes.push('depreciation_rate_percent')
  if (exactChanged(next.depreciation_units_total, existing.depreciation_units_total)) changes.push('depreciation_units_total')
  if (next.depreciation_convention !== existing.depreciation_convention) changes.push('depreciation_convention')
  if (next.depreciation_method !== existing.depreciation_method) changes.push('depreciation_method')
  if (next.depreciation_method_id !== existing.depreciation_method_id) changes.push('depreciation_method_id')
  return changes
}

export const POSTED_BASIS_EDIT_ERROR =
  'The depreciation basis of this asset is fixed once depreciation has posted. ' +
  'Correct it with a controlled adjustment (impairment, revaluation or disposal) instead of editing the asset.'

/**
 * Fail-closed gate: refuse a basis change once depreciation has posted for the
 * asset. Edits before anything posts remain free, and a request that leaves
 * every basis column untouched passes even on a fully depreciating asset.
 */
export function postedAssetBasisEditRefusal(
  hasPostedDepreciation: boolean,
  existing: AssetDepreciationBasis,
  requested: RequestedAssetBasis,
): string | null {
  if (!hasPostedDepreciation) return null
  if (assetBasisChanges(existing, requested).length === 0) return null
  return POSTED_BASIS_EDIT_ERROR
}
