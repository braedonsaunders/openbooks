import type { CategoryWeekly } from '../../../../lib/cash/core'

/**
 * The category table and the week flyout share one refusal rendering: the
 * catalog message selected by the refusal code, with its params. The
 * server's English message stays in logs, never on screen.
 */
export function categoryRefusalText(
  t: (key: string, params?: Record<string, string | number>) => string,
  c: CategoryWeekly,
): string | null {
  if (!c.unavailable) return null
  if (c.unavailable.code === 'card-threshold-missing') return t('catTable.unavailableCardThreshold', { name: c.name })
  return t('catTable.unavailableMissingRate', c.unavailable.params)
}
