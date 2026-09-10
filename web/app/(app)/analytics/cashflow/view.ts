import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { cashflowData } from '../../../../lib/analytics/cashflow-data'
import { withoutWeekEntries } from '../../../../lib/cash/core'
import type { CashflowView } from './CashflowView'

/**
 * The cashflow dashboard, split into a loader and a spec.
 *
 * Every analytics dashboard has the same two-part shape: the compact
 * `AnalyticsHeader` breadcrumb row with ONE control on its right, and a body
 * that is a single bespoke client view. So the header is a FRAME — it wraps a
 * spec-authored child — and the body is a widget. A frame rather than a
 * widget because the control genuinely varies per dashboard: six of the seven
 * place the shared period filter bar, and this one places its own horizon
 * control. A widget taking a `control` name string would be a component
 * reference smuggled through a spec, which the language forbids.
 *
 * Loader work copied VERBATIM: the `reports.read` gate, the 4/8/12 horizon
 * whitelist (anything else falls back to 4), and the `withoutWeekEntries`
 * trim. That trim is the interesting one, and its native comment is kept
 * below: week totals travel with the page, the transactions behind them do
 * not — the week flyout fetches whichever week is opened at full detail.
 */

type CashflowProps = Parameters<typeof CashflowView>[0]

export interface CashflowData {
  title: string
  backLabel: string
  periodLabel: string
  horizon: number
  data: CashflowProps['data']
}

export async function loadCashflow(sp: Record<string, string | undefined>): Promise<CashflowData> {
  const t = await getTranslations('analytics.cashflow')
  const authz = await requirePermission('reports.read')

  const parsed = Number(sp.horizon)
  const horizon = parsed === 8 || parsed === 12 ? parsed : 4

  const position = await cashflowData(authz.user.orgId, horizon, undefined, authz.allowedSubsidiaryIds)
  // Week totals, counts and the per-counterparty aggregate travel with the
  // page; the transactions behind them do not. The week flyout fetches
  // whichever week is opened from /api/cash/week-entries, at full detail.
  const data = { ...position, weeks: withoutWeekEntries(position.weeks) }

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    // The native header interpolates this literally, outside next-intl.
    periodLabel: `as of ${data.asOf}`,
    horizon,
    data,
  }
}

export function cashflowSpec(data: CashflowData): PageSpec {
  return page({
    layout: 'list',
    header: [
      frame(
        'analytics-header',
        [widgetBlock('cashflow-horizon-control', { value: data.horizon })],
        { title: data.title, periodLabel: data.periodLabel, backLabel: data.backLabel },
      ),
    ],
    body: [widgetBlock('cashflow-view', { data: data.data })],
  })
}
