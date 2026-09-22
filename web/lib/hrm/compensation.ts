import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import {
  listCycles,
  listCycleLines,
  cyclePacing,
  getCycle,
} from '@openbooks/engine/src/hrm/compensation/cycles.ts'
import {
  listPayBands,
  compaRatioFor,
} from '@openbooks/engine/src/hrm/compensation/bands.ts'
import {
  countBandHolders,
} from '@openbooks/engine/src/hrm/compensation/band-headcounts.ts'
import {
  listJobLevels,
} from '@openbooks/engine/src/hrm/compensation/architecture.ts'
import {
  listPlans,
  listPlanLines,
} from '@openbooks/engine/src/hrm/compensation/headcount-plans.ts'
import {
  latestGapSnapshot,
} from '@openbooks/engine/src/hrm/compensation/pay-transparency.ts'
import {
  listStatements,
} from '@openbooks/engine/src/hrm/compensation/statements.ts'
import { loadOwnEmploymentIds } from '@openbooks/engine/src/hrm/authorization.ts'
import { can, getAuthz, type Authz } from '../authz'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { isFeatureEnabled } from '../features'

/**
 * Compensation workspace loaders — one read per surface behind the
 * Compensation tab, the cycle/plan detail routes, the equity surface,
 * and the Me compensation section.
 *
 * Rows come from the compensation engine services (never direct table
 * reads from the web app) with display resolution (names, hrefs, labels)
 * keyed strictly by ids the service already authorized. Computed
 * refusals travel as data: pages render them beside the content, never
 * an empty table pretending to be data. Feature checks ride the
 * hrmCompensation parent with the merit/plans/transparency sub-keys at
 * their own routes.
 */

export interface CompStatTile {
  iconKey: string
  accent: string
  label: string
  value: string
  sub?: string
  tone: 'default' | 'positive' | 'warning' | 'negative'
}

export interface CompBandRow {
  id: string
  levelCode: string
  levelName: string
  range: string
  currency: string
  headcount: string
  belowMin: string
  inRange: string
  aboveMax: string
  noBand: string
}

export interface CompCycleRow {
  id: string
  name: string
  kindLabel: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  effectiveOn: string
  href: string
}

export interface CompPlanRow {
  id: string
  name: string
  period: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  totalCost: string
  href: string
}

export interface CompHomeData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  tiles: CompStatTile[]
  bandsTitle: string
  bandsColumns: { level: string; range: string; headcount: string; placement: string }
  bands: CompBandRow[]
  bandsEmpty: string
  cyclesTitle: string
  cyclesColumns: { name: string; status: string; effective: string }
  cycles: CompCycleRow[]
  cyclesEmpty: string
  plansTitle: string
  plansColumns: { name: string; status: string; cost: string }
  plans: CompPlanRow[]
  plansEmpty: string
  canManage: boolean
  canRunCycles: boolean
  newCycleHref: string
  newCycleLabel: string
  newPlanHref: string
  newPlanLabel: string
  equityHref: string
  equityLabel: string
  architectureTitle: string
  canSetup: boolean
}

function cycleStatusVariant(status: string): CompCycleRow['statusVariant'] {
  if (status === 'draft') return 'secondary'
  if (status === 'open' || status === 'in_review') return 'warning'
  if (status === 'approved' || status === 'pushed') return 'success'
  if (status === 'closed') return 'default'
  return 'outline'
}

async function workerNames(orgId: string, employmentIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (employmentIds.length === 0) return names
  const rows = (await db.execute<{ employment_id: string; name: string }>(sql`
    select e.id as employment_id, p.display_name as name
      from worker_employments e
      join parties p on p.id = e.worker_party_id and p.org_id = e.org_id
     where e.org_id = ${orgId} and e.id = any(${`{${employmentIds.join(',')}}`}::uuid[])`)).rows
  for (const row of rows) names.set(row.employment_id, row.name)
  return names
}

export async function loadCompensationHome(authz: Authz): Promise<CompHomeData | null> {
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrmCompensation'))) return null
  if (!can(authz, 'hrm.compensation.read')) return null
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const today = await businessToday(orgId)
  const canManage = can(authz, 'hrm.compensation.manage')
  const canRunCycles = canManage && (await isFeatureEnabled(orgId, 'hrmMeritCycles'))
  const [bands, levels, cycles, plans] = await Promise.all([
    listPayBands({ orgId, actorId: authz.user.id, asOf: today }).catch(() => []),
    listJobLevels({ orgId, actorId: authz.user.id }).catch(() => []),
    (await isFeatureEnabled(orgId, 'hrmMeritCycles')
      ? listCycles({ orgId, actorId: authz.user.id }).catch(() => [])
      : []),
    (await isFeatureEnabled(orgId, 'hrmHeadcountPlans')
      ? listPlans({ orgId, actorId: authz.user.id }).catch(() => [])
      : []),
  ])
  const levelById = new Map(levels.map((l) => [l.id, l]))
  // Headcount per band scope: employments whose position level the band
  // prices, resolved read-only through the fenced engine counter so the
  // count matches the caller lens (empty scope sees zero, never the
  // whole org). Band configuration itself stays visible; placement stays
  // the band service's job.
  const bandRows: CompBandRow[] = []
  for (const band of bands) {
    const level = levelById.get(band.levelId)
    const holders = await countBandHolders({ orgId, actorId: authz.user.id, levelId: band.levelId, asOf: today })
    bandRows.push({
      id: band.id,
      levelCode: level?.code ?? band.levelId.slice(0, 8),
      levelName: level?.name ?? '',
      range: `${band.min} – ${band.max} ${band.currency}`,
      currency: band.currency,
      headcount: String(holders),
      belowMin: '',
      inRange: '',
      aboveMax: '',
      noBand: '',
    })
  }
  const openCycles = cycles.filter((c) => c.status === 'open' || c.status === 'in_review')
  let pacingNote = ''
  let belowMinRound = '—'
  if (openCycles[0]) {
    const pacing = await cyclePacing(orgId, authz.user.id, openCycles[0].id).catch(() => null)
    if (pacing?.totalPct !== null && pacing?.totalPct !== undefined) {
      pacingNote = `${Math.round(pacing.totalPct)}%`
    }
    // Below-min on the live round: lines whose frozen rate sits under
    // their band's min edge (read back, never stored).
    try {
      const roundLines = await listCycleLines({ orgId, actorId: authz.user.id, cycleId: openCycles[0].id })
      const roundBandIds = [...new Set(roundLines.map((l) => l.bandId).filter((b): b is string => b !== null))]
      const roundEdges = new Map<string, string>()
      if (roundBandIds.length > 0) {
        const edgeRows = (await db.execute<{ id: string; min: string }>(sql`
          select id, min::text as min from hrm_pay_bands
           where org_id = ${orgId} and id = any(${`{${roundBandIds.join(',')}}`}::uuid[])`)).rows
        for (const row of edgeRows) roundEdges.set(row.id, row.min)
      }
      belowMinRound = String(
        roundLines.filter((l) => l.bandId !== null && Number(l.currentRate) < Number(roundEdges.get(l.bandId) ?? '0')).length,
      )
    } catch {
      belowMinRound = '—'
    }
  }
  const awaitingPlans = plans.filter((p) => p.status === 'submitted').length
  let jointFlags = 0
  if (await isFeatureEnabled(orgId, 'hrmPayTransparency')) {
    const snapshot = await latestGapSnapshot({ orgId, actorId: authz.user.id }).catch(() => null)
    jointFlags = snapshot?.categories.filter((c) => c.jointAssessmentDue).length ?? 0
  }
  const tiles: CompStatTile[] = [
    { iconKey: 'trending-down', accent: 'amber', label: t('compensation.tiles.belowMin'), value: belowMinRound, tone: 'default' },
    { iconKey: 'gauge', accent: 'blue', label: t('compensation.tiles.openCyclePacing'), value: pacingNote || '—', tone: 'default' },
    { iconKey: 'users', accent: 'violet', label: t('compensation.tiles.awaitingPlans'), value: String(awaitingPlans), tone: awaitingPlans > 0 ? 'warning' : 'default' },
    { iconKey: 'scale', accent: 'rose', label: t('compensation.tiles.jointFlags'), value: String(jointFlags), tone: jointFlags > 0 ? 'warning' : 'default' },
  ]
  const planRows: CompPlanRow[] = []
  for (const plan of plans.slice(0, 10)) {
    const lines = await listPlanLines({ orgId, actorId: authz.user.id, planId: plan.id }).catch(() => [])
    const total = lines.reduce((sum, l) => sum + Number(l.estAnnualCost), 0)
    planRows.push({
      id: plan.id,
      name: plan.name,
      period: `${plan.fiscalPeriodFrom} – ${plan.fiscalPeriodTo}`,
      status: plan.status,
      statusLabel: t.has(`compensation.planStatus.${plan.status}`) ? t(`compensation.planStatus.${plan.status}`) : plan.status,
      statusVariant: plan.status === 'approved' ? 'success' : plan.status === 'submitted' ? 'warning' : 'default',
      totalCost: total.toFixed(2),
      href: `/hrm/compensation/plans/${plan.id}`,
    })
  }
  return {
    title: t('compensation.title'),
    description: t('compensation.description'),
    tabs,
    tiles,
    bandsTitle: t('compensation.bandsTitle'),
    bandsColumns: {
      level: t('compensation.columns.level'),
      range: t('compensation.columns.range'),
      headcount: t('compensation.columns.headcount'),
      placement: t('compensation.columns.placement'),
    },
    bands: bandRows,
    bandsEmpty: t('compensation.bandsEmpty'),
    cyclesTitle: t('compensation.cyclesTitle'),
    cyclesColumns: { name: t('compensation.columns.name'), status: t('compensation.columns.status'), effective: t('compensation.columns.effective') },
    cycles: cycles.slice(0, 10).map((c) => ({
      id: c.id,
      name: c.name,
      kindLabel: t.has(`compensation.cycleKind.${c.kind}`) ? t(`compensation.cycleKind.${c.kind}`) : c.kind,
      status: c.status,
      statusLabel: t.has(`compensation.cycleStatus.${c.status}`) ? t(`compensation.cycleStatus.${c.status}`) : c.status,
      statusVariant: cycleStatusVariant(c.status),
      effectiveOn: c.effectiveOn,
      href: `/hrm/compensation/cycles/${c.id}`,
    })),
    cyclesEmpty: t('compensation.cyclesEmpty'),
    plansTitle: t('compensation.plansTitle'),
    plansColumns: { name: t('compensation.columns.name'), status: t('compensation.columns.status'), cost: t('compensation.columns.cost') },
    plans: planRows,
    plansEmpty: t('compensation.plansEmpty'),
    canManage,
    canRunCycles,
    newCycleHref: '/hrm/compensation?cycle=new',
    newCycleLabel: t('compensation.newCycle'),
    newPlanHref: '/hrm/compensation?plan=new',
    newPlanLabel: t('compensation.newPlan'),
    equityHref: '/hrm/compensation/equity',
    equityLabel: t('compensation.equity'),
    architectureTitle: t('compensation.architectureTitle'),
    canSetup: can(authz, 'admin.setup.manage'),
  }
}

export interface CompLineRow {
  id: string
  employeeName: string
  lineHref: string
  employeeHref: string | null
  current: string
  placement: 'below_min' | 'in_range' | 'above_max' | 'no_band'
  placementLabel: string
  placementMin: string | null
  placementTarget: string | null
  placementMax: string | null
  placementRate: string | null
  rating: string
  guideline: string
  proposedPct: string
  proposedRate: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  reason: string | null
  department: string
}

export interface CompCycleDetailData {
  cycleId: string
  title: string
  cycleName: string
  status: string
  statusLabel: string
  effectiveOn: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  pacingLabel: string
  pacingPct: number | null
  pacingOver: boolean
  pacingNote: string
  linesTitle: string
  columns: { employee: string; current: string; placement: string; rating: string; guideline: string; proposed: string; status: string }
  lines: CompLineRow[]
  linesEmpty: string
  departments: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  canDecide: boolean
  backHref: string
  backLabel: string
  cycleHref: string
  openLineId: string | null
  openLine: CompLineRow | null
  openLineHistory: { kind: string; actor: string | null; reason: string | null; at: string }[]
  drawerCloseHref: string
  drawerLabels: {
    proposeTitle: string
    decideTitle: string
    historyTitle: string
    pctLabel: string
    rateLabel: string
    reasonLabel: string
    failed: string
    submit: string
    cancel: string
    approve: string
    reject: string
    reopen: string
  }
  historyColumns: { event: string; reason: string; at: string }
  emptyHistory: string
}

export async function loadCompCycleDetail(
  authz: Authz,
  cycleId: string,
  sp: Record<string, string | undefined>,
): Promise<CompCycleDetailData | null> {
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrmMeritCycles'))) return null
  if (!can(authz, 'hrm.compensation.read')) return null
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const cycle = await getCycle({ orgId, actorId: authz.user.id, cycleId }).catch(() => null)
  if (!cycle) return null
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const lines = await listCycleLines({ orgId, actorId: authz.user.id, cycleId }).catch(() => [])
  const names = await workerNames(orgId, lines.map((l) => l.employmentId))
  const departments = new Map<string, { label: string; count: number }>()
  const deptOf = new Map<string, string>()
  const deptRows = (await db.execute<{ employment_id: string; department_id: string | null; name: string | null }>(sql`
    select aav.employment_id, aav.department_id, d.name
      from employment_assignment_versions aav
      left join departments d on d.id = aav.department_id and d.org_id = aav.org_id
     where aav.org_id = ${orgId} and aav.is_primary and aav.recorded_until is null
       and aav.employment_id = any(${`{${lines.map((l) => l.employmentId).join(',')}}`}::uuid[])`)).rows
  for (const row of deptRows) {
    deptOf.set(row.employment_id, row.department_id ?? '')
    if (row.department_id) {
      const entry = departments.get(row.department_id) ?? { label: row.name ?? row.department_id.slice(0, 8), count: 0 }
      entry.count += 1
      departments.set(row.department_id, entry)
    }
  }
  const segment = sp.department ?? ''
  const placementLabel = (p: string) =>
    t.has(`compensation.placement.${p}`) ? t(`compensation.placement.${p}`) : p
  // Band edges for the lines' bands: placement derives here (the lines
  // freeze the ratio at open; the edges render the bar).
  const bandIds = [...new Set(lines.map((l) => l.bandId).filter((b): b is string => b !== null))]
  const bandEdges = new Map<string, { min: string; target: string; max: string }>()
  if (bandIds.length > 0) {
    const edgeRows = (await db.execute<{ id: string; min: string; target: string; max: string }>(sql`
      select id, min::text as min, target::text as target, max::text as max
        from hrm_pay_bands
       where org_id = ${orgId} and id = any(${`{${bandIds.join(',')}}`}::uuid[])`)).rows
    for (const row of edgeRows) bandEdges.set(row.id, { min: row.min, target: row.target, max: row.max })
  }
  const rows: CompLineRow[] = lines
    .filter((l) => !segment || deptOf.get(l.employmentId) === segment)
    .map((l) => {
      const edges = l.bandId ? bandEdges.get(l.bandId) ?? null : null
      const placement =
        edges === null
          ? ('no_band' as const)
          : Number(l.currentRate) < Number(edges.min)
            ? ('below_min' as const)
            : Number(l.currentRate) > Number(edges.max)
              ? ('above_max' as const)
              : ('in_range' as const)
      const href = `/hrm/compensation/cycles/${cycleId}?line=${l.id}${segment ? `&department=${segment}` : ''}`
      return {
        id: l.id,
        employeeName: names.get(l.employmentId) ?? l.employmentId.slice(0, 8),
        lineHref: href,
        employeeHref: null,
        current: `${l.currentRate} ${l.currency}`,
        placement,
        placementLabel: placementLabel(placement),
        placementMin: edges?.min ?? null,
        placementTarget: edges?.target ?? null,
        placementMax: edges?.max ?? null,
        placementRate: l.currentRate,
        rating: l.ratingKey ?? '—',
        guideline:
          l.guidelineMinPct !== null && l.guidelineMaxPct !== null
            ? `${Number(l.guidelineMinPct)}% – ${Number(l.guidelineMaxPct)}%`
            : '—',
        proposedPct: l.proposedPct !== null ? `${Number(l.proposedPct)}%` : '—',
        proposedRate: l.proposedRate ?? '—',
        status: l.status,
        statusLabel: t.has(`compensation.lineStatus.${l.status}`) ? t(`compensation.lineStatus.${l.status}`) : l.status,
        statusVariant: l.status === 'approved' || l.status === 'pushed' ? 'success' : l.status === 'rejected' ? 'destructive' : l.status === 'proposed' ? 'warning' : 'default',
        reason: l.reason,
        department: deptOf.get(l.employmentId) ?? '',
      }
    })
  const pacing = await cyclePacing(orgId, authz.user.id, cycleId).catch(() => ({ totalPct: null as number | null, overBudget: false }))
  const openLineId = sp.line ?? null
  const openLine = rows.find((r) => r.id === openLineId) ?? null
  const history = openLineId
    ? (await db.execute<{ kind: string; actor: string | null; reason: string | null; at: string }>(sql`
      select kind, actor::text as actor, reason, recorded_at::text as at
        from hrm_comp_events
       where org_id = ${orgId} and cycle_id = ${cycleId} and (line_id = ${openLineId} or line_id is null)
       order by recorded_at`)).rows
    : []
  const actorNames = await workerNames(
    orgId,
    [],
  ).catch(() => new Map<string, string>())
  void actorNames
  return {
    cycleId,
    title: cycle.name,
    cycleName: cycle.name,
    status: cycle.status,
    statusLabel: t.has(`compensation.cycleStatus.${cycle.status}`) ? t(`compensation.cycleStatus.${cycle.status}`) : cycle.status,
    effectiveOn: cycle.effectiveOn,
    tabs,
    pacingLabel: t('compensation.pacing'),
    pacingPct: pacing.totalPct,
    pacingOver: pacing.overBudget,
    pacingNote: pacing.totalPct === null ? t('compensation.pacingNone') : t('compensation.pacingNote', { pct: Math.round(pacing.totalPct) }),
    linesTitle: t('compensation.linesTitle'),
    columns: {
      employee: t('compensation.columns.employee'),
      current: t('compensation.columns.current'),
      placement: t('compensation.columns.placement'),
      rating: t('compensation.columns.rating'),
      guideline: t('compensation.columns.guideline'),
      proposed: t('compensation.columns.proposed'),
      status: t('compensation.columns.status'),
    },
    lines: rows,
    linesEmpty: t('compensation.linesEmpty'),
    departments: [...departments.entries()].map(([value, entry]) => ({ value, label: entry.label, count: entry.count })),
    currentParams: { department: sp.department },
    canManage: can(authz, 'hrm.compensation.manage'),
    canDecide: can(authz, 'hrm.compensation.approve'),
    backHref: '/hrm/compensation',
    backLabel: t('compensation.back'),
    cycleHref: `/hrm/compensation/cycles/${cycleId}`,
    openLineId,
    openLine,
    openLineHistory: history.map((h) => ({
      kind: t.has(`compensation.eventKind.${h.kind}`) ? t(`compensation.eventKind.${h.kind}`) : h.kind,
      actor: h.actor,
      reason: h.reason,
      at: h.at,
    })),
    drawerCloseHref: `/hrm/compensation/cycles/${cycleId}${segment ? `?department=${segment}` : ''}`,
    drawerLabels: {
      proposeTitle: t('compensation.drawer.proposeTitle'),
      decideTitle: t('compensation.drawer.decideTitle'),
      historyTitle: t('compensation.drawer.historyTitle'),
      pctLabel: t('compensation.drawer.pctLabel'),
      rateLabel: t('compensation.drawer.rateLabel'),
      reasonLabel: t('compensation.drawer.reasonLabel'),
      failed: t('compensation.drawer.failed'),
      submit: t('compensation.drawer.submit'),
      cancel: t('compensation.drawer.cancel'),
      approve: t('compensation.drawer.approve'),
      reject: t('compensation.drawer.reject'),
      reopen: t('compensation.drawer.reopen'),
    },
    historyColumns: {
      event: t('compensation.historyColumns.event'),
      reason: t('compensation.historyColumns.reason'),
      at: t('compensation.historyColumns.at'),
    },
    emptyHistory: t('compensation.emptyHistory'),
  }
}

export interface CompPlanLineRow {
  id: string
  title: string
  kind: string
  kindLabel: string
  fte: string
  startOn: string
  cost: string
  currency: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  requisition: string | null
}

export interface CompPlanDetailData {
  title: string
  planName: string
  status: string
  statusLabel: string
  period: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  totalLabel: string
  totalCost: string
  linesTitle: string
  columns: { title: string; kind: string; fte: string; start: string; cost: string; status: string }
  lines: CompPlanLineRow[]
  linesEmpty: string
  canManage: boolean
  backHref: string
  backLabel: string
  approveLabel: string
}

export async function loadHeadcountPlanDetail(
  authz: Authz,
  planId: string,
): Promise<CompPlanDetailData | null> {
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrmHeadcountPlans'))) return null
  if (!can(authz, 'hrm.compensation.read')) return null
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const plans = await listPlans({ orgId, actorId: authz.user.id }).catch(() => [])
  const plan = plans.find((p) => p.id === planId) ?? null
  if (!plan) return null
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const lines = await listPlanLines({ orgId, actorId: authz.user.id, planId }).catch(() => [])
  const total = lines.reduce((sum, l) => sum + Number(l.estAnnualCost), 0)
  return {
    title: plan.name,
    planName: plan.name,
    status: plan.status,
    statusLabel: t.has(`compensation.planStatus.${plan.status}`) ? t(`compensation.planStatus.${plan.status}`) : plan.status,
    period: `${plan.fiscalPeriodFrom} – ${plan.fiscalPeriodTo}`,
    tabs,
    totalLabel: t('compensation.totalCost'),
    totalCost: total.toFixed(2),
    linesTitle: t('compensation.planLinesTitle'),
    columns: {
      title: t('compensation.columns.title'),
      kind: t('compensation.columns.kind'),
      fte: t('compensation.columns.fte'),
      start: t('compensation.columns.start'),
      cost: t('compensation.columns.cost'),
      status: t('compensation.columns.status'),
    },
    lines: lines.map((l) => ({
      id: l.id,
      title: l.title,
      kind: l.kind,
      kindLabel: t.has(`compensation.lineKind.${l.kind}`) ? t(`compensation.lineKind.${l.kind}`) : l.kind,
      fte: l.plannedFte,
      startOn: l.startOn,
      cost: `${l.estAnnualCost} ${l.currency}`,
      currency: l.currency,
      status: l.status,
      statusLabel: t.has(`compensation.planLineStatus.${l.status}`) ? t(`compensation.planLineStatus.${l.status}`) : l.status,
      statusVariant: l.status === 'filled' || l.status === 'approved' ? 'success' : l.status === 'rejected' ? 'destructive' : 'default',
      requisition: l.requisitionId,
    })),
    linesEmpty: t('compensation.planLinesEmpty'),
    canManage: can(authz, 'hrm.compensation.manage'),
    backHref: '/hrm/compensation',
    backLabel: t('compensation.back'),
    approveLabel: t('compensation.approveLine'),
  }
}

export interface EquityData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  hasSnapshot: boolean
  asOf: string
  tiles: CompStatTile[]
  categoriesTitle: string
  categoriesColumns: { category: string; counts: string; mean: string; median: string; unexplained: string; flag: string }
  categories: { id: string; level: string; counts: string; mean: string; median: string; unexplained: string; flag: string; flagTone: 'default' | 'warning' }[]
  categoriesEmpty: string
  canManage: boolean
  generateHref: string
  generateLabel: string
  emptyTitle: string
  emptyDescription: string
}

export async function loadEquity(authz: Authz): Promise<EquityData | null> {
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrmPayTransparency'))) return null
  if (!can(authz, 'hrm.compensation.read')) return null
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const snapshot = await latestGapSnapshot({ orgId, actorId: authz.user.id }).catch(() => null)
  const flags = snapshot?.categories.filter((c) => c.jointAssessmentDue).length ?? 0
  const tiles: CompStatTile[] = snapshot
    ? [
        { iconKey: 'scale', accent: 'blue', label: t('equity.meanGap'), value: fmtPct(snapshot.metrics.meanGapPct), tone: 'default' },
        { iconKey: 'scale', accent: 'violet', label: t('equity.medianGap'), value: fmtPct(snapshot.metrics.medianGapPct), tone: 'default' },
        { iconKey: 'coins', accent: 'amber', label: t('equity.variableGap'), value: fmtPct(snapshot.metrics.variablePayGapPct), tone: 'default' },
        { iconKey: 'flag', accent: 'rose', label: t('equity.jointFlags'), value: String(flags), tone: flags > 0 ? 'warning' : 'default' },
      ]
    : []
  return {
    title: t('equity.title'),
    description: t('equity.description'),
    tabs,
    hasSnapshot: snapshot !== null,
    asOf: snapshot?.asOf ?? '',
    tiles,
    categoriesTitle: t('equity.categoriesTitle'),
    categoriesColumns: {
      category: t('equity.columns.category'),
      counts: t('equity.columns.counts'),
      mean: t('equity.columns.mean'),
      median: t('equity.columns.median'),
      unexplained: t('equity.columns.unexplained'),
      flag: t('equity.columns.flag'),
    },
    categories: (snapshot?.categories ?? []).map((c) => ({
      id: c.levelId,
      level: c.levelCode,
      counts: `${c.countA} / ${c.countB}`,
      mean: fmtPct(c.meanGapPct),
      median: fmtPct(c.medianGapPct),
      unexplained: fmtPct(c.unexplainedGapPct),
      flag: c.jointAssessmentDue ? t('equity.jointDue') : '—',
      flagTone: (c.jointAssessmentDue ? 'warning' : 'default') as 'default' | 'warning',
    })),
    categoriesEmpty: t('equity.categoriesEmpty'),
    canManage: can(authz, 'hrm.compensation.manage'),
    generateHref: '/hrm/compensation/equity?generate=1',
    generateLabel: t('equity.generate'),
    emptyTitle: t('equity.emptyTitle'),
    emptyDescription: t('equity.emptyDescription'),
  }
}

function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export interface MyCompData {
  title: string
  description: string
  employmentId: string
  tabs: { href: string; label: string; active: boolean }[]
  hasContent: boolean
  placementLabel: string
  placement: string
  compaRatio: string | null
  bandRange: string | null
  statementsTitle: string
  statementsColumns: { period: string; generated: string }
  statements: { id: string; period: string; generated: string; pdfHref: string | null }[]
  statementsEmpty: string
  requestLabel: string
  requestHref: string
  requestFailed: string
  requestSubmit: string
  requestCancel: string
  requestStatus: string | null
}

export async function loadMyCompensation(authz: Authz): Promise<MyCompData | null> {
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrmCompensation'))) return null
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const own = await loadOwnEmploymentIds(db, orgId, authz.user.id).catch(() => [] as string[])
  if (own.length === 0) return null
  const employmentId = own[0]!
  const today = await businessToday(orgId)
  let placement = 'no_band'
  let compaRatio: string | null = null
  let bandRange: string | null = null
  try {
    const placed = await compaRatioFor(orgId, authz.user.id, employmentId, today)
    if (placed.band) {
      placement = placed.placement
      compaRatio = placed.compaRatio
      bandRange = `${placed.band.min} – ${placed.band.max} ${placed.band.currency}`
    }
  } catch {
    placement = 'no_band'
  }
  const statements = await listStatements({ orgId, actorId: authz.user.id, employmentId }).catch(() => [])
  const { meTabs } = await import('./self-service')
  const tabs = (await meTabs(authz, '/me/compensation')).map((t) => ({ href: t.href, label: t.label, active: t.active === true }))
  const openRequest = (await db.execute<{ status: string }>(sql`
    select status from hrm_pay_information_requests
     where org_id = ${orgId} and employment_id = ${employmentId} and status = 'open'
     order by requested_at desc limit 1`)).rows[0]
  const hasContent = placement !== 'no_band' || statements.length > 0
  return {
    title: t('myComp.title'),
    description: t('myComp.description'),
    employmentId,
    tabs,
    hasContent,
    placementLabel: t('myComp.placement'),
    placement: t.has(`compensation.placement.${placement}`) ? t(`compensation.placement.${placement}`) : placement,
    compaRatio,
    bandRange,
    statementsTitle: t('myComp.statementsTitle'),
    statementsColumns: { period: t('myComp.columns.period'), generated: t('myComp.columns.generated') },
    statements: statements.map((s) => ({
      id: s.id,
      period: `${s.periodFrom} – ${s.periodTo}`,
      generated: s.generatedAt.slice(0, 10),
      pdfHref: s.fileId ? `/api/hrm/comp-statements?pdf=${s.id}` : null,
    })),
    statementsEmpty: t('myComp.statementsEmpty'),
    requestLabel: t('myComp.requestPayInfo'),
    requestHref: '/me/compensation?request=1',
    requestFailed: t('myComp.requestFailed'),
    requestSubmit: t('myComp.requestSubmit'),
    requestCancel: t('myComp.requestCancel'),
    requestStatus: openRequest
      ? t.has(`myComp.requestStatus.${openRequest.status}`)
        ? t(`myComp.requestStatus.${openRequest.status}`)
        : openRequest.status
      : null,
  }
}

export async function compensationAuthz(): Promise<Authz | null> {
  return getAuthz()
}
