import { parseReportQuery } from '../report-filters'
import { normalizeCashHorizonWeeks } from '../cash/horizon'
import { agingPeriodPreset } from '../aging-periods'

/** Cards and selected tabs share a canonical source identity. Unrelated URL
 * controls cannot fragment the aggregate cache. */
export function analyticsSourceQuery(sp: Record<string, string | undefined>, slug?: string): Record<string, string | undefined> {
  const query = parseReportQuery(slug === 'receivables-intelligence' ? { ...sp, period: agingPeriodPreset(sp.period) } : sp)
  return {
    period: query.period,
    ...(query.period === 'custom' ? { from: query.from, to: query.to } : {}),
    ...(sp.horizon === undefined ? {} : { horizon: String(normalizeCashHorizonWeeks(sp.horizon, 4)) }),
  }
}

export function analyticsQueryString(sp: Record<string, string | undefined>, slug?: string): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(analyticsSourceQuery(sp, slug))) if (value !== undefined) params.set(key, value)
  return params.toString()
}
