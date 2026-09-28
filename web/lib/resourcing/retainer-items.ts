/** Recognition-rule facts the retainer item picker filters on. */
export type RetainerItemRule = {
  method: string | null
  isForecast: boolean | null
}

/**
 * The single eligibility rule for the retainer item picker, shared by the
 * list loader and the drawer: an hours retainer needs a usage rule, a fees
 * retainer a milestone rule, and a forecast rule never backs a billed
 * retainer. An item without a matching rule is not offered.
 */
export function isRetainerItemEligible(
  kind: 'hours' | 'fees',
  rule: RetainerItemRule | null,
): boolean {
  if (rule === null) return false
  if (rule.isForecast) return false
  return rule.method === (kind === 'hours' ? 'usage' : 'milestone')
}
