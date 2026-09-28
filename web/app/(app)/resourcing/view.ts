import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { ResourcingRefusal } from '@openbooks/engine/src/resourcing/errors.ts'
import { addCalendarDays, businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { weekStartOf } from '@openbooks/engine/src/resourcing/weeks.ts'
import { groupTabs } from '../../../components/module-home/group-tabs'
import type { ModuleHomeTab } from '../../../components/module-home/ui'
import { resourcingHome } from '../../../lib/module-home/resourcing'
import { loadPlanVsActual, type PlanVsActualRow } from '../../../lib/resourcing/tie-out'
import {
  loadBusySeason,
  type BusySeasonData,
  type BusySeasonGap,
  type BusySeasonProject,
} from '../../../lib/resourcing/busy-season'
import type { BusySeasonLabels } from './BusySeasonSection'
import type { TieOutLabels } from './TieOutTable'

/**
 * The resourcing cockpit, split into a loader and a spec.
 *
 * The shape follows the purchasing cockpit exactly: ViewSpec composes the
 * grid and the panels, and the panel body (the plan-vs-actual tie-out) is a
 * shared section component. Its vitals come from the landed board/forecast
 * readers; utilization is the landed utilization formula evaluated over the
 * contributor rows, never a local division.
 */

export interface ResourcingCockpitData {
  title: string
  description: string
  tabs: ModuleHomeTab[]
  utilizationHref: string
  capacityLabel: string
  capacityValue: string
  capacitySub: string
  benchLabel: string
  benchValue: string
  rolloffsLabel: string
  rolloffsValue: string
  overallocatedLabel: string
  overallocatedValue: string
  utilizationLabel: string
  utilizationValue: string
  utilizationSub: string
  tieoutTitle: string
  tieoutHint: string
  tieoutEmpty: string
  tieout: PlanVsActualRow[]
  tieoutLabels: TieOutLabels
  busySeasonTitle: string
  busySeasonHint: string
  busySeason: {
    gaps: BusySeasonGap[]
    projects: BusySeasonProject[]
    labels: BusySeasonLabels
    canCreateDraft: boolean
  }
}

export async function loadResourcing(
  sp: Record<string, string | undefined>,
): Promise<ResourcingCockpitData> {
  const authz = await requirePermission('resourcing.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'resourcing')
  const t = await getTranslations('resourcing.cockpit')
  void sp

  const today = await businessToday(orgId)
  const tieoutLast = weekStartOf(today)
  const tieoutFirst = addCalendarDays(tieoutLast, -21)
  const seasonYear = today.slice(0, 4)
  const [home, tieout, tabs, busyResult] = await Promise.all([
    resourcingHome(orgId, authz.allowedSubsidiaryIds),
    loadPlanVsActual(orgId, authz.allowedSubsidiaryIds, {
      firstSunday: tieoutFirst,
      lastSunday: tieoutLast,
    }),
    groupTabs('resourcing', '/resourcing', { orgId }),
    loadBusySeason(orgId, authz.allowedSubsidiaryIds, { seasonYear }).then(
      (data): { ok: true; data: BusySeasonData } => ({ ok: true, data }),
      (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
    ),
  ])
  // A computed busy-season refusal is panel content, not a page error: the
  // operator reads its exact message and remedy where the gaps would be.
  const busyRefusal = !busyResult.ok && busyResult.error instanceof ResourcingRefusal
    ? { message: busyResult.error.message, remedy: busyResult.error.remedy }
    : null
  if (!busyResult.ok && !busyRefusal) throw busyResult.error
  const busySeason: BusySeasonData = busyResult.ok
    ? busyResult.data
    : { seasonYear, spans: [], gaps: [], projects: [] }
  const bt = await getTranslations('resourcing.busySeason')
  const requestsOn = await isFeatureEnabled(orgId, 'resourceRequests')
  const canManage = can(authz, 'resourcing.manage')
  const canCreateDraft = !busyRefusal && canManage && requestsOn
  const refusalText = busyRefusal
    ? `${busyRefusal.message}${busyRefusal.remedy ? ` ${busyRefusal.remedy}` : ''}`
    : null
  const spanText = busySeason.spans
    .map((span) => span.firstSunday === span.lastSunday ? span.firstSunday : `${span.firstSunday}–${span.lastSunday}`)
    .join(', ')
  const busySeasonHint = refusalText
    ?? (busySeason.spans.length === 0
      ? bt('noMarkers')
      : canManage && !requestsOn
        ? `${bt('hint', { spans: spanText })} ${bt('featureRemedy')}`
        : bt('hint', { spans: spanText }))

  // The capacity vital sums only known net-capacity rows: the subline says
  // so, naming the people with unknown capacity instead of presenting a
  // partial sum as a complete total. Nothing is invented for unknown rows.
  const capacitySub = home.unknownCapacityPeople > 0
    ? t('vitals.capacityUnknown', { count: home.unknownCapacityPeople })
    : t('vitals.capacityResolved')
  const utilizationSub = home.unknownCapacityPeople > 0
    ? `${t('vitals.utilizationSub', { from: home.firstSunday, to: home.lastSunday })} · ${t('vitals.capacityUnknown', { count: home.unknownCapacityPeople })}`
    : t('vitals.utilizationSub', { from: home.firstSunday, to: home.lastSunday })

  return {
    title: t('title'),
    description: t('description'),
    tabs,
    utilizationHref: '/reports/resourcing/utilization',
    capacityLabel: t('vitals.capacity'),
    capacityValue: `${home.netCapacity} h`,
    capacitySub,
    benchLabel: t('vitals.bench'),
    benchValue: String(home.benchPeople),
    rolloffsLabel: t('vitals.rolloffs'),
    rolloffsValue: String(home.rolloffs),
    overallocatedLabel: t('vitals.overallocated'),
    overallocatedValue: String(home.overallocatedWeeks),
    utilizationLabel: t('vitals.utilization'),
    utilizationValue: home.utilization ?? t('vitals.utilizationUndefined'),
    utilizationSub,
    tieoutTitle: t('tieout.title'),
    tieoutHint: t('tieout.hint'),
    tieoutEmpty: t('tieout.empty'),
    busySeasonTitle: bt('title', { year: seasonYear }),
    busySeasonHint,
    busySeason: {
      gaps: busySeason.gaps,
      projects: busySeason.projects,
      labels: {
        empty: refusalText ?? (busySeason.spans.length === 0 ? bt('noMarkers') : bt('empty')),
        weekOf: bt('weekOf'),
        gap: bt('gap'),
        demand: bt('demand'),
        capacity: bt('capacity'),
        plan: bt('plan'),
        evidence: bt('evidence'),
        staff: bt('staff'),
        assignments: t('tieout.assignments'),
        opportunities: bt('opportunities'),
        absences: t('tieout.absences'),
        holidays: t('tieout.holidays'),
        requestAction: bt('requestAction'),
        noProjects: bt('noProjects'),
        confirmTitle: bt('confirmTitle'),
        projectLabel: bt('projectLabel'),
        confirm: bt('confirm'),
        created: bt('created'),
        requestFailed: bt('requestFailed'),
        reason: bt('reason'),
      },
      canCreateDraft,
    },
    tieout,
    tieoutLabels: {
      person: t('tieout.person'),
      week: t('tieout.week'),
      planned: t('tieout.planned'),
      approved: t('tieout.approved'),
      variance: t('tieout.variance'),
      capacity: t('tieout.capacity'),
      evidence: t('tieout.evidence'),
      empty: t('tieout.empty'),
      noCapacity: t('tieout.noCapacity'),
      overallocated: t('tieout.overallocated'),
      assignments: t('tieout.assignments'),
      absences: t('tieout.absences'),
      leaveRequest: t('tieout.leaveRequest'),
      holidays: t('tieout.holidays'),
      scheduleTier: t('tieout.scheduleTier'),
    },
  }
}

const f = ref<ResourcingCockpitData>()

export function resourcingSpec(data: ResourcingCockpitData): PageSpec {
  return page({
    route: '/resourcing',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          statTile({ iconKey: 'gauge', accent: 'sky', label: f('capacityLabel'), value: f('capacityValue'), sub: f('capacitySub') }),
          statTile({ iconKey: 'users', accent: 'teal', label: f('benchLabel'), value: f('benchValue') }),
          statTile({ iconKey: 'timer', accent: 'amber', label: f('rolloffsLabel'), value: f('rolloffsValue') }),
          statTile({ iconKey: 'triangle-alert', accent: 'red', label: f('overallocatedLabel'), value: f('overallocatedValue') }),
          // The utilization tile IS the report link: the shared home stat
          // tile wrapped in a Next link, so the visual stays the house one.
          widgetBlock('resourcing-utilization-tile', {
            label: data.utilizationLabel,
            value: data.utilizationValue,
            sub: data.utilizationSub,
            href: data.utilizationHref,
          }),
        ]),
        panel({
          title: f('tieoutTitle'),
          iconKey: 'list-checks',
          hint: f('tieoutHint'),
          bodyClassName: 'p-0',
          className: 'min-h-0 flex-1',
          blocks: [
            widgetBlock('resourcing-tieout', {
              rows: data.tieout,
              labels: data.tieoutLabels,
              empty: data.tieoutEmpty,
            }),
          ],
        }),
        panel({
          title: f('busySeasonTitle'),
          iconKey: 'trending-up',
          hint: f('busySeasonHint'),
          bodyClassName: 'p-0',
          className: 'shrink-0',
          blocks: [
            widgetBlock('resourcing-busy-season', {
              canCreateDraft: data.busySeason.canCreateDraft,
              gaps: data.busySeason.gaps,
              labels: data.busySeason.labels,
              projects: data.busySeason.projects,
            }),
          ],
        }),
      ]),
    ],
  })
}
