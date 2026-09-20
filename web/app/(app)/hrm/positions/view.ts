import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  grid,
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { HrmPositionError } from '@openbooks/engine/src/hrm/positions.ts'
import { getPositionAsOf, getVacancyAsOf } from '@openbooks/engine/src/hrm/positions-read.ts'
import { hrmGroupTabs } from '../../../../components/module-home/group-tabs'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import type { PositionRowDTO } from '@openbooks/engine/src/hrm/positions-read.ts'

/**
 * Positions tab, split into a loader and a spec.
 *
 * Follows the change-requests list archetype: ViewSpec composes the header
 * and the grid; the segment pills, the vacancy table, and the URL drawer
 * stay components shared by the page and the widget registry via
 * ./sections so they cannot drift. Status segments filter server-side; a
 * row opens the position drawer (versions, funding by period, current
 * holder) through the URL, so the selection is shareable and the drawer
 * closes by navigation. Renders only when the hrm feature gate is on and
 * the actor holds hrm.position.read — the view 404s otherwise, the same
 * gate the route-gate scanner reads on the cockpit.
 */

const STATUSES = ['planned', 'open', 'filled', 'frozen', 'closed'] as const

export interface PositionSegment {
  key: string
  label: string
  href: string
  active: boolean
  count: number
}

export interface PositionRow {
  id: string
  code: string
  title: string
  status: string
  statusLabel: string
  department: string | null
  plannedFte: string
  fundedFte: string
  filledFte: string
  vacantFte: string
  holderLabel: string
  refusal: string | null
  href: string
}

export interface PositionsPageData {
  title: string
  description: string
  tabs: { href: string; label: string; active?: boolean }[]
  effectiveDate: string
  segments: PositionSegment[]
  columns: Record<string, string>
  rows: PositionRow[]
  empty: string
  totalLabel: string
  totals: { plannedFte: string; fundedFte: string; filledFte: string; vacantFte: string }
  detail: {
    code: string
    title: string
    version: string
    effective: string
    recorded: string
    plannedFte: string
    statusLabel: string
    fundingTitle: string
    funding: { period: string; funded: string; costPlan: string | null }[]
    unfunded: string
    holderTitle: string
    holder: string | null
    noHolder: string
    warningsTitle: string
    warnings: string[]
    refusal: string | null
    closeHref: string
  } | null
  missingDetail: string | null
  drawerOpen: boolean
  drawer: {
    closeHref: string
    title: string
    description: string | null
    detail: PositionsPageData['detail']
    missingDetail: string | null
  } | null
}

const f = ref<PositionsPageData>()

export function positionsSpec(data: PositionsPageData): PageSpec {
  return page({
    route: '/hrm/positions',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        widgetBlock('hrm-position-segments', {
          ariaLabel: data.title,
          segments: data.segments,
        }),
        widgetBlock('hrm-positions-table', {
          columns: data.columns,
          rows: data.rows,
          empty: data.empty,
          totals: data.totals,
          totalLabel: data.totalLabel,
        }),
      ]),
      // URL-backed drawer, portaled to <body> wherever it renders.
      {
        ...widgetBlock('hrm-position-drawer', { drawer: data.drawer }),
        when: f('drawerOpen'),
      },
    ],
  })
}

function hrefFor(effectiveDate: string, status: string | null, positionId: string | null): string {
  const params = new URLSearchParams({ effectiveDate })
  if (status) params.set('status', status)
  if (positionId) params.set('position', positionId)
  return `/hrm/positions?${params.toString()}`
}

export async function positionsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('positions.title')
}

export async function loadPositionsPage(
  sp: Record<string, string | undefined>,
): Promise<PositionsPageData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.position.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  const t = await getTranslations('hrm')
  const tabs = await hrmGroupTabs(authz, '/hrm/positions')

  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status)
    ? sp.status
    : null
  const rawDate = typeof sp.effectiveDate === 'string' ? sp.effectiveDate : null
  const effectiveDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : await businessToday(authz.user.orgId)
  const positionId = typeof sp.position === 'string' && sp.position.length > 0
    ? sp.position
    : null

  const vacancy = await getVacancyAsOf({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    effectiveDate,
    knownAt: new Date().toISOString(),
  })
  const departmentNames = new Map<string, string>()
  for (const group of vacancy.byDepartment) {
    if (group.departmentId !== null && group.departmentName !== null) {
      departmentNames.set(group.departmentId, group.departmentName)
    }
  }
  const statusLabel = (value: string): string =>
    value === 'planned' ? t('positions.statusPlanned')
    : value === 'open' ? t('positions.statusOpen')
    : value === 'filled' ? t('positions.statusFilled')
    : value === 'frozen' ? t('positions.statusFrozen')
    : t('positions.statusClosed')

  const allRows = vacancy.positions
  const counts = new Map<string, number>()
  for (const row of allRows) counts.set(row.version.status, (counts.get(row.version.status) ?? 0) + 1)
  const segments: PositionSegment[] = [
    { key: 'all', label: t('positions.statusAll'), href: hrefFor(effectiveDate, null, null), active: status === null, count: allRows.length },
    ...STATUSES.map((value) => ({
      key: value,
      label: statusLabel(value),
      href: hrefFor(effectiveDate, value, null),
      active: status === value,
      count: counts.get(value) ?? 0,
    })),
  ]
  const holderLabel = (row: PositionRowDTO): string =>
    row.holders.length === 0
      ? t('positions.columns.unassignedHolder')
      : t('positions.holdersCount', { count: row.holders.length })

  const rows: PositionRow[] = allRows
    .filter((row) => status === null || row.version.status === status)
    .map((row) => ({
      id: row.id,
      code: row.positionCode,
      title: row.version.title,
      status: row.version.status,
      statusLabel: statusLabel(row.version.status),
      department: row.version.departmentId === null ? null : (departmentNames.get(row.version.departmentId) ?? row.version.departmentId),
      plannedFte: row.vacancy.plannedFte,
      fundedFte: row.vacancy.fundedFte,
      filledFte: row.vacancy.filledFte,
      vacantFte: row.vacancy.vacantFte,
      holderLabel: holderLabel(row),
      refusal: row.vacancy.refusal?.message ?? null,
      href: hrefFor(effectiveDate, status, row.id),
    }))

  let detail: PositionsPageData['detail'] = null
  let missingDetail: string | null = null
  if (positionId !== null) {
    try {
      const resolved = await getPositionAsOf({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        positionId,
        effectiveDate,
        knownAt: new Date().toISOString(),
      })
      const to = resolved.version.effectiveTo
      detail = {
        code: resolved.positionCode,
        title: resolved.version.title,
        version: t('positions.drawer.versionNo', { no: resolved.version.versionNo }),
        effective: to === null
          ? t('positions.drawer.effectiveOpen', { from: resolved.version.effectiveFrom })
          : t('positions.drawer.effective', { from: resolved.version.effectiveFrom, to }),
        recorded: t('positions.drawer.recorded', { at: resolved.version.recordedAt }),
        plannedFte: resolved.version.plannedFte,
        statusLabel: statusLabel(resolved.version.status),
        fundingTitle: t('positions.drawer.funding'),
        funding: resolved.funding.map((plan) => ({
          period: t('positions.drawer.period', { from: plan.periodStartsOn, to: plan.periodEndsOn }),
          funded: t('positions.drawer.funded', { fte: plan.fundedFte }),
          costPlan: plan.amount !== null && plan.currency !== null
            ? t('positions.drawer.costPlan', { amount: plan.amount, currency: plan.currency })
            : null,
        })),
        unfunded: t('positions.drawer.unfunded'),
        holderTitle: t('positions.drawer.holder'),
        holder: resolved.holders.length === 0
          ? null
          : resolved.holders.map((holder) => t('positions.drawer.holderEmployment', { id: holder.employmentId })).join(', '),
        noHolder: t('positions.drawer.noHolder', { date: effectiveDate }),
        warningsTitle: t('positions.drawer.warnings'),
        warnings: [...resolved.disagreementWarnings],
        refusal: resolved.vacancy.refusal?.message ?? null,
        closeHref: hrefFor(effectiveDate, status, null),
      }
    } catch (error) {
      // A bookmarked id that no longer resolves (never a live list id)
      // renders the drawer with a named absence, never a broken list.
      if (error instanceof HrmPositionError && (error.code === 'NOT_FOUND' || /not visible/.test(error.message))) {
        missingDetail = t('positions.drawer.missing')
      } else {
        throw error
      }
    }
  }

  const title = t('positions.title')
  const drawerOpen = detail !== null || missingDetail !== null
  return {
    title,
    description: t('positions.description'),
    tabs,
    effectiveDate,
    segments,
    columns: {
      code: t('positions.columns.code'),
      title: t('positions.columns.title'),
      status: t('positions.columns.status'),
      department: t('positions.columns.department'),
      planned: t('positions.columns.planned'),
      funded: t('positions.columns.funded'),
      filled: t('positions.columns.filled'),
      vacant: t('positions.columns.vacant'),
      holder: t('positions.columns.holder'),
    },
    rows,
    empty: t('positions.empty'),
    totalLabel: t('positions.total'),
    totals: {
      plannedFte: vacancy.totals.plannedFte,
      fundedFte: vacancy.totals.fundedFte,
      filledFte: vacancy.totals.filledFte,
      vacantFte: vacancy.totals.vacantFte,
    },
    detail,
    missingDetail,
    drawerOpen,
    drawer: drawerOpen
      ? {
          closeHref: detail?.closeHref ?? '/hrm/positions',
          title: detail ? detail.code : title,
          description: detail ? detail.title : null,
          detail,
          missingDetail,
        }
      : null,
  }
}
