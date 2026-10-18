import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { serviceHomeSummary, type ServiceHomeSummary } from '@openbooks/engine/service/reads'
import { listBoards } from '@openbooks/engine/schedule-boards/boards'
import { boardHasCapability } from '@openbooks/engine/schedule-boards/board-types'
import { can } from '../../../lib/authz'
import { requireServiceArea } from '../../../lib/service/pages'
import { builtInReportDefinitionId } from '../../../lib/custom-reports'
import { serviceActor } from '../../../lib/service/authority'

/**
 * The service home: counts that need attention, the dispatch boards and the
 * service reports. Lists live on their own tabs (requests, jobs, visits,
 * agreements); this page links into them.
 */
export interface ServiceHomeData {
  title: string
  description: string
  summary: ServiceHomeSummary
  boards: { code: string; name: string }[]
  reports: { href: string; title: string }[]
  canConfigure: boolean
  canCreateBoard: boolean
  canCreate: boolean
  newLabel: string
}

/** Built-in report slugs in the Reports hub, and their titles in the service catalog. */
export const SERVICE_REPORTS = [
  ['service-jobs-by-status', 'service_jobs_by_status'],
  ['service-technician-utilization', 'service_technician_utilization'],
  ['service-first-time-fix', 'service_first_time_fix'],
  ['service-quote-win-rate', 'service_quote_win_rate'],
  ['service-revenue-per-job', 'service_revenue_per_job'],
] as const

export async function loadServiceHome(): Promise<ServiceHomeData> {
  const { authz, capabilities } = await requireServiceArea()
  const actor = serviceActor(authz)
  const t = await getTranslations('service')
  const [summary, boards, reportIds] = await Promise.all([
    serviceHomeSummary(actor),
    listBoards(actor, { generalOnly: true }),
    can(authz, 'reports.read') ? Promise.all(SERVICE_REPORTS.map(([slug]) => builtInReportDefinitionId(authz.user.orgId, slug))) : Promise.resolve(SERVICE_REPORTS.map(() => null)),
  ])
  return {
    title: t('pages.home.title'),
    description: t('pages.home.description'),
    summary,
    boards: boards.filter((board) => boardHasCapability(board, 'dispatch')).map(({ code, name }) => ({ code, name })),
    // Reports open from the hub's run page; a report the organization cannot read is not listed.
    reports: SERVICE_REPORTS.flatMap(([, key], index) => (reportIds[index] ? [{ href: `/reports/custom/run/${reportIds[index]}`, title: t(`reports.${key}`) }] : [])),
    canConfigure: can(authz, 'admin.setup.manage'),
    canCreateBoard: can(authz, 'admin.setup.manage'),
    canCreate: capabilities.manage,
    newLabel: t('pages.requests.new'),
  }
}

const f = ref<ServiceHomeData>()

export function serviceHomeSpec(data: ServiceHomeData): PageSpec {
  return page({
    route: '/service',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('service-new-button', { kind: 'request', label: data.newLabel, basePath: '/service/requests' }, f('canCreate'))],
      }),
    ],
    body: [
      widgetBlock('service-home', {
        summary: data.summary,
        boards: data.boards,
        reports: data.reports,
        canConfigure: data.canConfigure,
        canCreateBoard: data.canCreateBoard,
      }),
    ],
  })
}
