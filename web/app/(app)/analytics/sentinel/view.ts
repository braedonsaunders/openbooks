import 'server-only'

import { getLocale, getTranslations } from 'next-intl/server'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { redirect } from 'next/navigation'
import { requirePermission } from '../../../../lib/authz'
import { accessDeniedHref } from '../../../../lib/gate-targets'
import { sentinelAccessDenied } from '../../../../lib/analytics/sentinel-access'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { sentinelData } from '../../../../lib/analytics/sentinel-data'
import { sentinelStrings } from '../../../../lib/analytics/sentinel-strings'
import type { SentinelView } from './SentinelView'

/**
 * Sentinel forensics, split into a loader and a spec.
 *
 * The dashboard shape is the family shape: the compact `AnalyticsHeader`
 * breadcrumb row wrapping ONE control, and a body that is a single bespoke
 * client view. The header is a FRAME because it wraps a spec-authored child;
 * the control is the shared `report-period-filter` widget (`controls={{ period:
 * true }}`), byte-identical across six of the seven dashboards. The body
 * stays whole: charts, drill tables and client filter state live in the view,
 * and decomposing them into generic blocks would reimplement the component
 * rather than compose it.
 *
 * Loader work copied VERBATIM from page.tsx. The gate here is the strictest in the app —
 * full-ledger forensics demands an unrestricted subsidiary fence AND
 * `admin.audit.read`, and anything less redirects to /access-denied naming
 * the missing requirement. It runs in the loader, so the gate runs in the
 * loader.
 *
 * `sentinelData` takes the whole `Authz` because it fences its own SQL. That
 * object never reaches the spec: the loader hands the widget the finished
 * findings, which is the whole point of the loader/spec split.
 */

type ViewProps = Parameters<typeof SentinelView>[0]

export interface SentinelData {
  title: string
  backLabel: string
  periodLabel: string
  data: ViewProps['data']
}

export async function loadSentinel(sp: Record<string, string | undefined>): Promise<SentinelData> {
  const t = await getTranslations('analytics.sentinel')
  const authz = await requirePermission('reports.read')
  // The house refusal names the missing requirement (F1T-10) — the same
  // name the API maps to its 403 — never a silent bounce home.
  const sentinelDenied = sentinelAccessDenied(authz)
  if (sentinelDenied !== null) redirect(accessDeniedHref({ permission: sentinelDenied }))

  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  // Forensic sentences resolve through the analytics catalog in the request
  // locale — the same locale the statements use. Conformity travels as a
  // stable code in every language; the client maps codes to words.
  const [tc, locale] = await Promise.all([getTranslations('analytics'), getLocale()])
  const strings = sentinelStrings((key, values) => tc(key, values), locale)
  const data = await sentinelData(authz.user.orgId, { from: period.from, to: period.to, label: period.label }, authz, strings)

  return {
    title: t('title'),
    backLabel: t('backToHub'),
    periodLabel: period.label,
    data,
  }
}

export function sentinelSpec(data: SentinelData): PageSpec {
  return page({
    route: '/analytics/sentinel',
    layout: 'list',
    header: [
      frame('analytics-header', [widgetBlock('report-period-filter')], {
        title: data.title,
        periodLabel: data.periodLabel,
        backLabel: data.backLabel,
      }),
    ],
    body: [widgetBlock('sentinel-view', { data: data.data })],
  })
}
