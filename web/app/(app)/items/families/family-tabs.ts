export type FamilyTabKey = 'variants' | 'pricing' | 'options' | 'details'

const FAMILY_TABS: readonly FamilyTabKey[] = ['variants', 'pricing', 'options', 'details']

/**
 * The `familyTab` search param names the family drawer's active subtab.
 * Unknown or missing values fall back to the everyday variants matrix, so a
 * deep link never strands the operator on an empty body.
 */
export function familyTabFromParam(value: unknown): FamilyTabKey {
  return FAMILY_TABS.includes(value as FamilyTabKey) ? (value as FamilyTabKey) : 'variants'
}

export function familyTabs(): readonly FamilyTabKey[] {
  return FAMILY_TABS
}
