/** Aging is a position at a date, rather than a flow over a fiscal window.
 * Unknown or range presets resolve to today on every aging surface. */
export const AGING_PERIOD_PRESETS = ['today', 'yesterday', 'last_month', 'custom'] as const

export function agingPeriodPreset(requested?: string): string {
  return AGING_PERIOD_PRESETS.some((preset) => preset === requested) ? requested! : 'today'
}
