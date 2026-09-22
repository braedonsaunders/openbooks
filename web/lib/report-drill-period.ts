import 'server-only'
import { resolvePeriod } from './periods'
import { applyLedgerDrillWindow, type ReportDrillTarget } from './report-drill'

/**
 * Re-resolve a period-browsable ledger drill against the house period picker.
 * Statement cell drills omit `period` so their encoded window stays the cell
 * they tied out to — overlaying those would silently break the tie-out.
 */
export async function overlayLedgerDrillPeriod(
  target: ReportDrillTarget,
  query: { period?: string | null; from?: string | null; to?: string | null },
  orgId: string,
): Promise<ReportDrillTarget> {
  if (target.kind !== 'ledger' || !target.period) return target
  const period = query.period || (query.from || query.to ? 'custom' : null)
  if (!period) return target
  const resolved = await resolvePeriod(period, {
    customFrom: query.from,
    customTo: query.to,
    orgId,
  })
  return applyLedgerDrillWindow(target, {
    from: resolved.from,
    to: resolved.to,
    period: resolved.presetId,
  })
}
