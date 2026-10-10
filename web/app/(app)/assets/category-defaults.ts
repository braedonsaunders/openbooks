/**
 * Asset-category defaults in the asset drawer.
 *
 * A category carries the asset, accumulated-depreciation and depreciation
 * expense accounts plus the default method, life and convention. A new or
 * draft asset shows them as soon as its category is chosen, and a field keeps
 * following the category until the operator changes it: switching category
 * replaces a field only while it is blank or still holds the previous
 * category's default.
 */

export interface AssetCategoryDefaultsSource {
  id: string
  asset_account_id?: string | null
  accumulated_depreciation_account_id?: string | null
  depreciation_expense_account_id?: string | null
  default_method?: string | null
  default_depreciation_method_id?: string | null
  default_life_months?: number | string | null
  default_convention?: string | null
}

export interface AssetCategoryFields {
  assetAccountId: string
  accumAccountId: string
  expenseAccountId: string
  method: string
  depreciationMethodId: string
  lifeMonths: string
  convention: string
}

/** Method and convention the drawer shows when a category names none. */
const FALLBACK_METHOD = 'straight_line'
const FALLBACK_CONVENTION = 'full_month'

/**
 * The drawer values a category implies. Accounts the operator cannot choose
 * here (outside the drawer's account options) are left blank rather than
 * shown as an unselectable value; the server still resolves the category's
 * account for an asset that names none.
 */
export function categoryDefaultFields(
  category: AssetCategoryDefaultsSource | null | undefined,
  selectableAccountIds: ReadonlySet<string>,
): AssetCategoryFields {
  const account = (id: string | null | undefined) => (id && selectableAccountIds.has(id) ? id : '')
  return {
    assetAccountId: account(category?.asset_account_id),
    accumAccountId: account(category?.accumulated_depreciation_account_id),
    expenseAccountId: account(category?.depreciation_expense_account_id),
    method: category?.default_method || FALLBACK_METHOD,
    depreciationMethodId: category?.default_depreciation_method_id ?? '',
    lifeMonths: category?.default_life_months != null ? String(category.default_life_months) : '',
    convention: category?.default_convention || FALLBACK_CONVENTION,
  }
}

/**
 * The fields after switching category: each field the operator has not
 * overridden takes the new category's default.
 */
export function applyCategoryDefaults(
  current: AssetCategoryFields,
  previousDefaults: AssetCategoryFields | null,
  nextDefaults: AssetCategoryFields,
): AssetCategoryFields {
  const follows = (value: string, previous: string | undefined) =>
    value === '' || (previous !== undefined && value === previous)
  const out = { ...current }
  for (const key of ['assetAccountId', 'accumAccountId', 'expenseAccountId', 'lifeMonths', 'convention'] as const) {
    if (follows(current[key], previousDefaults?.[key])) out[key] = nextDefaults[key]
  }
  // A formula method and a built-in method are one choice, so the pair
  // follows the category together or not at all.
  const choice = (fields: AssetCategoryFields) =>
    fields.depreciationMethodId ? `formula:${fields.depreciationMethodId}` : `builtin:${fields.method}`
  if (previousDefaults !== null && choice(current) === choice(previousDefaults)) {
    out.method = nextDefaults.method
    out.depreciationMethodId = nextDefaults.depreciationMethodId
  }
  return out
}
