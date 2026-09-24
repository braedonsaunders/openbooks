import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  ref,
  spanRow,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { HrmPositionError } from '@openbooks/engine/src/hrm/positions.ts'
import { getPositionAsOf, getVacancyAsOf } from '@openbooks/engine/src/hrm/positions-read.ts'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { hrmGroupTabs } from '../../../../components/module-home/group-tabs'
import { hrmHiringViewTabs } from '../../../../lib/hrm/workspace-tabs'
import { depthTabOptions } from '../recruiting/depth-view'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { rootSubsidiary, subsidiaryUiOptions } from '../../../../lib/subsidiaries'
import type { PositionRowDTO } from '@openbooks/engine/src/hrm/positions-read.ts'
import type { PositionCreateProps } from './PositionCreateForm'

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

export interface PositionSegmentOption {
  value: string
  label: string
  count: number
}

export interface PositionRow {
  id: string
  code: string
  title: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
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
  viewTabs: { href: string; label: string; active?: boolean }[]
  /** hrm.position.manage: the header's Add position button and the create form. */
  canManage: boolean
  addLabel: string
  /** The create form through the URL (`?position=new`), keeping the as-of date and segment. */
  addHref: string
  basePath: string
  effectiveDate: string
  segments: PositionSegment[]
  segmentsLabel: string
  allLabel: string
  asOfLabel: string
  segmentOptions: PositionSegmentOption[]
  currentParams: Record<string, string | string[] | undefined>
  columns: {
    code: string
    title: string
    status: string
    department: string
    planned: string
    funded: string
    filled: string
    vacant: string
    holder: string
  }
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
  /** The create form's loader-resolved inputs when the URL asks for `position=new`. */
  create: PositionCreateProps | null
  drawerOpen: boolean
  drawer: {
    closeHref: string
    title: string
    description: string | null
    detail: PositionsPageData['detail']
    missingDetail: string | null
    create?: PositionCreateProps | null
  } | null
}

const f = ref<PositionsPageData>()
const item = field

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
        actions: [
          // The primary action first, the strip last — the house order on
          // every list page, so the switcher never moves between siblings.
          widget('link-button', { href: f('addHref'), label: f('addLabel'), iconKey: 'plus' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        // The house toolbar, not a lone dropdown floating over a bare table.
        // The as-of date was reachable only by hand-editing `effectiveDate`
        // in the URL before this — a filter with no control is a filter
        // nobody can use.
        widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
        widgetBlock('list-toolbar', {
          basePath: '/hrm/positions',
          currentParams: data.currentParams,
          filters: [
            {
              paramKey: 'status',
              label: data.segmentsLabel,
              allLabel: data.allLabel,
              options: data.segmentOptions,
            },
          ],
          date: {
            paramKey: 'effectiveDate',
            label: data.asOfLabel,
            resolved: data.effectiveDate,
          },
        }),
        table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          empty: { title: f('empty') },
          // Totals only beside rows: with no rows the `empty` state
          // renders instead, so a filtered-empty list never shows the
          // org-wide totals under it. A present-but-empty `trailing`
          // array would suppress the empty state, so this is undefined.
          trailing:
            data.rows.length > 0
              ? [
                  spanRow({
                    label: f('totalLabel'),
                    labelColSpan: 4,
                    cells: [
                      { cell: text(f('totals.plannedFte')), align: 'right', className: 'font-semibold tabular-nums' },
                      { cell: text(f('totals.fundedFte')), align: 'right', className: 'font-semibold tabular-nums' },
                      { cell: text(f('totals.filledFte')), align: 'right', className: 'font-semibold tabular-nums' },
                      { cell: text(f('totals.vacantFte')), align: 'right', className: 'font-semibold tabular-nums' },
                    ],
                  }),
                ]
              : undefined,
          columns: [
            column(data.columns.code, link(item('code'), item('href'))),
            column(data.columns.title, text(item('title'))),
            column(data.columns.status, badge(item('statusLabel'), { variant: item('statusVariant') })),
            column(data.columns.department, text(item('department'), { fallback: '—' })),
            column(data.columns.planned, text(item('plannedFte')), { align: 'right', className: 'tabular-nums' }),
            column(data.columns.funded, text(item('fundedFte')), { align: 'right', className: 'tabular-nums' }),
            column(data.columns.filled, text(item('filledFte')), { align: 'right', className: 'tabular-nums' }),
            column(data.columns.vacant, text(item('vacantFte')), { align: 'right', className: 'tabular-nums' }),
            column(data.columns.holder, text(item('holderLabel'))),
          ],
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
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  const t = await getTranslations('hrm')
  const tc = await getTranslations('common')
  const tabs = await hrmGroupTabs(authz, '/hrm/positions')

  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status)
    ? sp.status
    : null
  const rawDate = typeof sp.effectiveDate === 'string' ? sp.effectiveDate : null
  const effectiveDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : await businessToday(authz.user.orgId)
  const canManage = can(authz, 'hrm.position.manage')
  const creating = sp.position === 'new' && canManage
  const positionId = typeof sp.position === 'string' && sp.position.length > 0 && sp.position !== 'new'
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
  const statusVariant = (value: string): PositionRow['statusVariant'] =>
    value === 'open' ? 'success'
    : value === 'planned' ? 'secondary'
    : value === 'frozen' ? 'warning'
    : value === 'closed' ? 'outline'
    : 'default'

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
      statusVariant: statusVariant(row.version.status),
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
          : resolved.holders.map((holder) => t('positions.drawer.holderEmployment', { name: holder.workerName })).join(', '),
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

  // The create form's inputs, resolved here so nothing but strings and ids
  // cross into the client: the employers the viewer may see (one fixed value
  // when the org runs a single entity), the active departments, and the
  // statuses a new position may open in (filled needs a holder, closed is
  // an end, so neither is offered on create).
  let create: PositionCreateProps | null = null
  if (creating) {
    const visible = await subsidiaryUiOptions(authz.user.orgId)
    const scoped = visible.filter((option) => authz.allowedSubsidiaryIds === null || authz.allowedSubsidiaryIds.has(option.id))
    // Names, never ids: a single-entity org creates against its named root,
    // while a caller scoped out of every visible entity is refused by name.
    let employers = scoped.map((option) => ({ value: option.id, label: option.name }))
    let employerRefusal: string | null = null
    if (employers.length === 0) {
      if (visible.length === 0) {
        const root = await rootSubsidiary(authz.user.orgId)
        employers = [{ value: root.id, label: root.name }]
      } else {
        employerRefusal = t('positions.create.noEmployer')
      }
    }
    const departmentRows = (await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from departments
       where org_id = ${authz.user.orgId}::uuid and is_active
       order by name`)).rows
    create = {
      basePath: '/hrm/positions',
      effectiveDate,
      employers,
      employerRefusal,
      departments: departmentRows.map((row) => ({ value: row.id, label: row.name })),
      statuses: (['planned', 'open', 'frozen'] as const).map((value) => ({ value, label: statusLabel(value) })),
      labels: {
        code: t('positions.create.code'),
        title: t('positions.create.titleField'),
        employer: t('positions.create.employer'),
        department: t('positions.create.department'),
        noDepartment: t('positions.create.noDepartment'),
        plannedFte: t('positions.create.plannedFte'),
        status: t('positions.create.status'),
        effectiveFrom: t('positions.create.effectiveFrom'),
        reason: t('positions.create.reason'),
        reasonPlaceholder: t('positions.create.reasonPlaceholder'),
        submit: t('positions.create.submit'),
        failed: t('positions.create.failed'),
      },
    }
  }

  const title = t('positions.title')
  const drawerOpen = detail !== null || missingDetail !== null || create !== null
  // Depth tabs land on /hrm/recruiting. A positions-only viewer must not
  // be offered Openings / Interviews / … that access-deny.
  const depthTabs = can(authz, 'hrm.recruiting.read')
    ? await depthTabOptions(authz, t, status)
    : []
  const viewTabs = await hrmHiringViewTabs(
    authz,
    '/hrm/positions',
    depthTabs.map((option) => ({
      href: option.href,
      label: option.label,
      active: false,
    })),
  )
  return {
    title,
    description: t('positions.description'),
    tabs,
    viewTabs,
    canManage,
    addLabel: t('positions.add'),
    addHref: hrefFor(effectiveDate, status, 'new'),
    basePath: '/hrm/positions',
    effectiveDate,
    segments,
    segmentsLabel: t('positions.segmentsLabel'),
    allLabel: t('positions.statusAll'),
    asOfLabel: tc('labels.asOf'),
    segmentOptions: STATUSES.map((value) => ({
      value,
      label: statusLabel(value),
      count: counts.get(value) ?? 0,
    })),
    // The as-of date survives a segment change; the status param itself is
    // driven by the filter, and the drawer selection closes like the native
    // pills did (hrefFor dropped it too).
    currentParams: status === null ? { effectiveDate } : { effectiveDate, status },
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
    create,
    drawerOpen,
    drawer: drawerOpen
      ? {
          closeHref: detail?.closeHref ?? hrefFor(effectiveDate, status, null),
          title: create ? t('positions.create.title') : detail ? detail.code : title,
          description: detail ? detail.title : null,
          detail,
          missingDetail,
          create,
        }
      : null,
  }
}
