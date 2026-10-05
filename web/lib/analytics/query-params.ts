import { parseReportQuery } from '../report-filters'
import { normalizeCashHorizonWeeks } from '../cash/horizon'

/** Cards and selected tabs share a canonical source identity. Unrelated URL
 * controls cannot fragment the aggregate cache. */
export function analyticsSourceQuery(sp: Record<string, string | undefined>): Record<string, string | undefined> {
  const query = parseReportQuery(sp)
  return {
    period: query.period,
    ...(query.period === 'custom' ? { from: query.from, to: query.to } : {}),
    ...(sp.horizon === undefined ? {} : { horizon: String(normalizeCashHorizonWeeks(sp.horizon, 4)) }),
  }
}

export function analyticsQueryString(sp: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(analyticsSourceQuery(sp))) if (value !== undefined) params.set(key, value)
  return params.toString()
}
