import { parseReportQuery } from '../report-filters'
import { normalizeCashHorizonWeeks } from '../cash/horizon'

/** Cards and selected tabs share a canonical source identity. Unrelated URL
 * controls cannot fragment the aggregate cache. */
export function analyticsSourceQuery(sp: Record<string, string | undefined>, slug?: string): Record<string, string | undefined> {
  const query = parseReportQuery(sp)
  return {
    period: query.period,
    ...(slug === 'receivables-intelligence' ? {
      ...(sp.customerQ?.trim() ? { customerQ: sp.customerQ.trim().slice(0, 160) } : {}),
      ...(sp.customerPage ? { customerPage: String(Math.max(1, Math.min(10000, Number.parseInt(sp.customerPage, 10) || 1))) } : {}),
      ...(['deteriorating', 'severe', 'delivery', 'terms', 'held'].includes(sp.signal ?? '') ? { signal: sp.signal } : {}),
    } : {}),
    ...(query.period === 'custom' ? { from: query.from, to: query.to } : {}),
    ...(sp.horizon === undefined ? {} : { horizon: String(normalizeCashHorizonWeeks(sp.horizon, 4)) }),
  }
}

export function analyticsQueryString(sp: Record<string, string | undefined>, slug?: string): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(analyticsSourceQuery(sp, slug))) if (value !== undefined) params.set(key, value)
  return params.toString()
}
