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
import { CompensationError } from '@openbooks/engine/src/hrm/compensation/errors.ts'
import { HrmAuthorizationError, loadApprovalPerson, loadOwnEmploymentIds } from '@openbooks/engine/src/hrm/authorization.ts'
import { can, getAuthz, type Authz } from '../authz'
import { setupSectionParams } from '../list-params'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { hrmRewardsViewTabs } from './workspace-tabs'
import { isFeatureEnabled } from '../features'
import { requireFeatureEnabled } from '../feature-gates'

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

/**
 * A computed dialog refusal travels as data with the dialog that requested
 * it: a missing manage grant or a switched-off sub-feature renders a NAMED
 * refusal with its remedy inside the open dialog — never an empty drawer,
 * never a silent close. Null when the dialog may render its form.
 */
export interface CompDialogRefusal {
  title: string
  message: string
}

/** State for the new-cycle URL dialog (?cycle=new) on the compensation home. */
export interface CompCycleDialogState {
  open: boolean
  closeHref: string
  title: string
  kinds: { value: string; label: string }[]
  kindLabel: string
  nameLabel: string
  effectiveLabel: string
  currencyLabel: string
  failed: string
  submit: string
  cancel: string
  refusal: CompDialogRefusal | null
  /** Setup managers get the real switch: the Features switchboard href. */
  remedyHref: string | null
  remedyLabel: string | null
}

/** State for the new-plan URL dialog (?plan=new) on the compensation home. */
export interface CompPlanDialogState {
  open: boolean
  closeHref: string
  title: string
  nameLabel: string
  fromLabel: string
  toLabel: string
  failed: string
  submit: string
  cancel: string
  refusal: CompDialogRefusal | null
  /** Setup managers get the real switch: the Features switchboard href. */
  remedyHref: string | null
  remedyLabel: string | null
}

/** State for the snapshot-generate URL dialog (?generate=1) on equity. */
export interface CompEquityDialogState {
  open: boolean
  closeHref: string
  title: string
  asOfLabel: string
  groupALabel: string
  groupBLabel: string
  failed: string
  submit: string
  cancel: string
  refusal: CompDialogRefusal | null
  remedyHref: string | null
  remedyLabel: string | null
}

export interface CompHomeData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  viewTabs: Awaited<ReturnType<typeof hrmRewardsViewTabs>>
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
  /**
   * The shared return href for both create dialogs: the home route with
   * every dialog param navigated away (the change-request queue's
   * dialogCloseHref pattern).
   */
  dialogCloseHref: string
  /** True while ?cycle=new is present — the spec renders the cycle dialog. */
  cycleOpen: boolean
  /** Null unless ?cycle=new is present; carries the form or its refusal. */
  cycleDialog: CompCycleDialogState | null
  /** True while ?plan=new is present — the spec renders the plan dialog. */
  planOpen: boolean
  /** Null unless ?plan=new is present; carries the form or its refusal. */
  planDialog: CompPlanDialogState | null
  equityHref: string
  equityLabel: string
  architectureTitle: string
  canSetup: boolean
  /**
   * OM-18/CK-09: the search params the rehomed job-architecture sections
   * read (namespaced drawer keys open each section's New/edit drawer in
   * SetupEntitySection). The home page carries no other list state, so
   * this is the section's own list params verbatim.
   */
  setupParams: Record<string, string | string[] | undefined>
  /**
   * Named domain/auth refusal from the gap-snapshot read (a scoped reader
   * cannot read org-wide frozen aggregates). Renders as data beside the
   * tiles — never a zero joint-flag count pretending the read succeeded.
   * Null when the snapshot read succeeded (or genuinely found no snapshot).
   */
  refusal: { title: string; message: string } | null
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

/** First of a search param that may repeat; Next hands arrays for ?x=a&x=b. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export async function loadCompensationHome(
  authz: Authz,
  sp: Record<string, string | string[] | undefined> = {},
): Promise<CompHomeData | null> {
  if (!can(authz, 'hrm.compensation.read')) return null
  await requireFeatureEnabled(authz.user.orgId, 'hrmCompensation')
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const viewTabs = await hrmRewardsViewTabs(authz, '/hrm/compensation')
  const today = await businessToday(orgId)
  const canManage = can(authz, 'hrm.compensation.manage')
  const meritOn = await isFeatureEnabled(orgId, 'hrmMeritCycles')
  const plansOn = await isFeatureEnabled(orgId, 'hrmHeadcountPlans')
  const canRunCycles = canManage && meritOn
  const [bands, levels, cycles, plans] = await Promise.all([
    listPayBands({ orgId, actorId: authz.user.id, asOf: today }).catch(() => []),
    listJobLevels({ orgId, actorId: authz.user.id }).catch(() => []),
    (meritOn ? listCycles({ orgId, actorId: authz.user.id }).catch(() => []) : []),
    (plansOn ? listPlans({ orgId, actorId: authz.user.id }).catch(() => []) : []),
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
  // A refused snapshot read (a scoped reader cannot read org-wide frozen
  // aggregates) travels as data with its remedy intact: the tile shows
  // unavailable, never a zero that reads as "no flags". A genuinely
  // absent snapshot still counts zero. Unexpected DB/system failures
  // propagate — never an empty tile.
  let jointFlags: number | null = 0
  let gapRefusal: CompHomeData['refusal'] = null
  if (await isFeatureEnabled(orgId, 'hrmPayTransparency')) {
    try {
      const snapshot = await latestGapSnapshot({ orgId, actorId: authz.user.id })
      jointFlags = snapshot?.categories.filter((c) => c.jointAssessmentDue).length ?? 0
    } catch (error) {
      if (error instanceof CompensationError || error instanceof HrmAuthorizationError) {
        gapRefusal = { title: t('compensation.title'), message: error.message }
        jointFlags = null
      } else {
        throw error
      }
    }
  }
  const tiles: CompStatTile[] = [
    { iconKey: 'trending-down', accent: 'amber', label: t('compensation.tiles.belowMin'), value: belowMinRound, tone: 'default' },
    { iconKey: 'gauge', accent: 'blue', label: t('compensation.tiles.openCyclePacing'), value: pacingNote || '—', tone: 'default' },
    { iconKey: 'users', accent: 'violet', label: t('compensation.tiles.awaitingPlans'), value: String(awaitingPlans), tone: awaitingPlans > 0 ? 'warning' : 'default' },
    { iconKey: 'scale', accent: 'rose', label: t('compensation.tiles.jointFlags'), value: jointFlags === null ? '—' : String(jointFlags), tone: jointFlags !== null && jointFlags > 0 ? 'warning' : 'default' },
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
  // The create dialogs (?cycle=new / ?plan=new): the loader owns the open
  // state and the return href, exactly like the change-request queue's
  // propose/detail trio. A requested dialog ALWAYS resolves — with its form
  // when every prerequisite holds, with a NAMED refusal (and its remedy)
  // otherwise. Permission gates match the header buttons (canRunCycles for
  // cycles, canManage for plans); the sub-feature switches ride alongside.
  // The gate-explanation copy is shared with the feature-required and
  // access-denied pages (shell.routeState), and the feature display names
  // with the Features switchboard (admin.features) — no second source.
  const dialogCloseHref = '/hrm/compensation'
  const cycleOpen = firstParam(sp.cycle) === 'new'
  const planOpen = firstParam(sp.plan) === 'new'
  let cycleDialog: CompCycleDialogState | null = null
  let planDialog: CompPlanDialogState | null = null
  if (cycleOpen || planOpen) {
    const g = await getTranslations('shell.routeState')
    const adminT = await getTranslations('admin')
    const canSetup = can(authz, 'admin.setup.manage')
    const manageRefusal = (): CompDialogRefusal => ({
      title: g('deniedTitle'),
      message: `${g('deniedDescription', { permission: 'hrm.compensation.manage' })} ${g('askAdministrator')}`,
    })
    const featureRefusal = (featureKey: 'hrmMeritCycles' | 'hrmHeadcountPlans'): CompDialogRefusal => {
      const nameKey = `features.${featureKey}.title`
      const name = adminT.has(nameKey) ? adminT(nameKey) : featureKey
      return {
        title: g('featureOffTitle', { name }),
        message: `${g('featureOffDescription', { name })}${canSetup ? '' : ` ${g('askAdministrator')}`}`,
      }
    }
    // Setup managers get the real switch beside a feature-off refusal; the
    // route is the switchboard the Features hierarchy owns (the
    // feature-required page links the same destination).
    const featureRemedy = canSetup
      ? { remedyHref: '/admin/setup/features' as string | null, remedyLabel: g('turnOnFeature') as string | null }
      : { remedyHref: null as string | null, remedyLabel: null as string | null }
    if (cycleOpen) {
      // Permission first: without the grant the switch cannot help. The
      // Features link rides only the feature-off refusal (a person is the
      // remedy for a missing grant, never a link).
      const refusal = !canManage ? manageRefusal() : !meritOn ? featureRefusal('hrmMeritCycles') : null
      const featureOff = canManage && !meritOn
      cycleDialog = {
        open: true,
        closeHref: dialogCloseHref,
        title: t('compensation.newCycle'),
        kinds: (['merit', 'promotion', 'adjustment', 'cola'] as const).map((kind) => ({
          value: kind,
          label: t.has(`compensation.cycleKind.${kind}`) ? t(`compensation.cycleKind.${kind}`) : kind,
        })),
        kindLabel: t('compensation.columns.kind'),
        nameLabel: t('compensation.columns.name'),
        effectiveLabel: t('compensation.columns.effective'),
        currencyLabel: t('recruiting.offerCard.currency'),
        failed: t('compensation.drawer.failed'),
        submit: t('compensation.drawer.submit'),
        cancel: t('compensation.drawer.cancel'),
        refusal,
        remedyHref: featureOff ? featureRemedy.remedyHref : null,
        remedyLabel: featureOff ? featureRemedy.remedyLabel : null,
      }
    }
    if (planOpen) {
      const refusal = !canManage ? manageRefusal() : !plansOn ? featureRefusal('hrmHeadcountPlans') : null
      const featureOff = canManage && !plansOn
      planDialog = {
        open: true,
        closeHref: dialogCloseHref,
        title: t('compensation.newPlan'),
        nameLabel: t('compensation.columns.name'),
        fromLabel: t('performance.periodStart'),
        toLabel: t('performance.periodEnd'),
        failed: t('compensation.drawer.failed'),
        submit: t('compensation.drawer.submit'),
        cancel: t('compensation.drawer.cancel'),
        refusal,
        remedyHref: featureOff ? featureRemedy.remedyHref : null,
        remedyLabel: featureOff ? featureRemedy.remedyLabel : null,
      }
    }
  }
  return {
    title: t('compensation.title'),
    description: t('compensation.description'),
    tabs,
    viewTabs,
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
    dialogCloseHref,
    cycleOpen,
    cycleDialog,
    planOpen,
    planDialog,
    equityHref: '/hrm/compensation/equity',
    equityLabel: t('compensation.equity'),
    architectureTitle: t('compensation.architectureTitle'),
    canSetup: can(authz, 'admin.setup.manage'),
    // CK-09: the three job-architecture sections read their New/edit
    // drawers from namespaced keys — one URL opens exactly one drawer.
    setupParams: setupSectionParams(sp, ['family', 'level', 'band']),
    refusal: gapRefusal,
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

/**
 * Item-level actions the merit transition table allows on the open line
 * (F3-38): propose while the round is live and the line is undecided;
 * decide while the round is live or approved and the line is proposed.
 * Anything else (pushed/closed/cancelled rounds, decided lines) hides
 * the forms — the engine refuses them anyway, but the operator never
 * gets to try. Per-line manageability stays engine-enforced.
 */
export function lineActionAvailability(
  cycleStatus: string,
  lineStatus: string | null,
): { canPropose: boolean; canDecideLine: boolean } {
  const roundLive = cycleStatus === 'open' || cycleStatus === 'in_review';
  return {
    canPropose: roundLive && (lineStatus === 'pending' || lineStatus === 'proposed'),
    canDecideLine: (roundLive || cycleStatus === 'approved') && lineStatus === 'proposed',
  };
}

export interface CompCycleDetailData {
  cycleId: string
  title: string
  cycleName: string
  status: string
  statusLabel: string
  effectiveOn: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  viewTabs: Awaited<ReturnType<typeof hrmRewardsViewTabs>>
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
  lineActions: { canPropose: boolean; canDecideLine: boolean }
  openLineHistory: { kind: string; actor: string | null; reason: string | null; at: string }[]
  drawerCloseHref: string
  drawerLabels: {
    proposeTitle: string
    decideTitle: string
    historyTitle: string
    pctLabel: string
    rateLabel: string
    reasonLabel: string
    pctInvalid: string
    decideReasonLabel: string
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
  if (!can(authz, 'hrm.compensation.read')) return null
  await requireFeatureEnabled(authz.user.orgId, 'hrmMeritCycles')
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const cycle = await getCycle({ orgId, actorId: authz.user.id, cycleId }).catch(() => null)
  if (!cycle) return null
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const viewTabs = await hrmRewardsViewTabs(authz, '/hrm/compensation')
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
    viewTabs,
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
    lineActions: lineActionAvailability(cycle.status, openLine?.status ?? null),
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
      pctInvalid: t('compensation.drawer.pctInvalid'),
      decideReasonLabel: t('compensation.drawer.decideReasonLabel'),
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
  viewTabs: Awaited<ReturnType<typeof hrmRewardsViewTabs>>
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
  if (!can(authz, 'hrm.compensation.read')) return null
  await requireFeatureEnabled(authz.user.orgId, 'hrmHeadcountPlans')
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const plans = await listPlans({ orgId, actorId: authz.user.id }).catch(() => [])
  const plan = plans.find((p) => p.id === planId) ?? null
  if (!plan) return null
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const viewTabs = await hrmRewardsViewTabs(authz, '/hrm/compensation')
  const lines = await listPlanLines({ orgId, actorId: authz.user.id, planId }).catch(() => [])
  const total = lines.reduce((sum, l) => sum + Number(l.estAnnualCost), 0)
  return {
    title: plan.name,
    planName: plan.name,
    status: plan.status,
    statusLabel: t.has(`compensation.planStatus.${plan.status}`) ? t(`compensation.planStatus.${plan.status}`) : plan.status,
    period: `${plan.fiscalPeriodFrom} – ${plan.fiscalPeriodTo}`,
    tabs,
    viewTabs,
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
  viewTabs: Awaited<ReturnType<typeof hrmRewardsViewTabs>>
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
  /** True while ?generate is present — the spec renders the generate dialog. */
  generateOpen: boolean
  /** Null unless ?generate is present; carries the form or its refusal. */
  generateDialog: CompEquityDialogState | null
  emptyTitle: string
  emptyDescription: string
  /**
   * Named domain/auth refusal from the snapshot read (a scoped reader
   * cannot read org-wide frozen aggregates). Renders as data with the
   * snapshot grid and table suppressed — never an empty page pretending
   * no snapshot was ever computed. Null when the read succeeded,
   * including a genuine no-snapshot empty state.
   */
  refusal: { title: string; message: string } | null
  /**
   * False only while a snapshot refusal is present, suppressing the
   * snapshot-specific grid and table (the leave-queue `hasContent`
   * pattern). Genuine no-snapshot emptiness still renders its table.
   */
  hasContent: boolean
}

export async function loadEquity(
  authz: Authz,
  sp: Record<string, string | string[] | undefined> = {},
): Promise<EquityData | null> {
  if (!can(authz, 'hrm.compensation.read')) return null
  await requireFeatureEnabled(authz.user.orgId, 'hrmPayTransparency')
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const canManage = can(authz, 'hrm.compensation.manage')
  // The generate dialog (?generate=1): the loader owns the open state and
  // the return href, like the home create dialogs. A requested dialog ALWAYS
  // resolves — the form for managers, a NAMED permission refusal otherwise.
  // The feature switch cannot be off here (this loader redirects above), so
  // no feature-off refusal exists on this surface.
  const generateOpen = firstParam(sp.generate) !== undefined
  let generateDialog: CompEquityDialogState | null = null
  if (generateOpen) {
    const g = await getTranslations('shell.routeState')
    generateDialog = {
      open: true,
      closeHref: '/hrm/compensation/equity',
      title: t('equity.generate'),
      asOfLabel: t('orgChart.asOf'),
      groupALabel: t('equity.groupA'),
      groupBLabel: t('equity.groupB'),
      failed: t('compensation.drawer.failed'),
      submit: t('compensation.drawer.submit'),
      cancel: t('compensation.drawer.cancel'),
      refusal: canManage
        ? null
        : {
            title: g('deniedTitle'),
            message: `${g('deniedDescription', { permission: 'hrm.compensation.manage' })} ${g('askAdministrator')}`,
          },
      remedyHref: null,
      remedyLabel: null,
    }
  }
  const tabs = await hrmGroupTabs(authz, '/hrm/compensation')
  const viewTabs = await hrmRewardsViewTabs(authz, '/hrm/compensation/equity')
  // A refused snapshot read travels as data with its remedy intact — never
  // an empty page pretending no snapshot exists. A genuinely absent
  // snapshot keeps the empty state. Unexpected DB/system failures
  // propagate — never an empty page or a misleading business refusal.
  let snapshot: Awaited<ReturnType<typeof latestGapSnapshot>> = null
  let refusal: EquityData['refusal'] = null
  try {
    snapshot = await latestGapSnapshot({ orgId, actorId: authz.user.id })
  } catch (error) {
    if (error instanceof CompensationError || error instanceof HrmAuthorizationError) {
      refusal = { title: t('equity.title'), message: error.message }
    } else {
      throw error
    }
  }
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
    viewTabs,
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
    canManage,
    generateHref: '/hrm/compensation/equity?generate=1',
    generateLabel: t('equity.generate'),
    generateOpen,
    generateDialog,
    emptyTitle: t('equity.emptyTitle'),
    emptyDescription: t('equity.emptyDescription'),
    refusal,
    hasContent: refusal === null,
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
  /**
   * True when the person is linked but holds no band and no statement: the
   * page renders its explicit empty state with the pay-information request
   * as the next step instead of an ambiguous 404.
   */
  showEmpty: boolean
  /** The pay-information request applies only while an employment resolves. */
  canRequest: boolean
  emptyTitle: string
  emptyDescription: string
  /**
   * Named no-link refusal (the /me documents/surveys shape): set only by
   * myCompRefusal for a login with no employment — the page renders the
   * house empty-state block with the remedy, never notFound(). Null on
   * every loadMyCompensation row.
   */
  refusal: { title: string; message: string } | null
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
  await requireFeatureEnabled(authz.user.orgId, 'hrmCompensation')
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  // OM-08: a linked person with no employment is a different state from no
  // linked person — and a missing user row is neither. The person read
  // throws when the identity is not established (never a refusal), an
  // unlinked login returns null (the notLinked refusal), and a linked
  // login with no employment returns the noEmployment refusal below.
  const person = await loadApprovalPerson(db, orgId, authz.user.id)
  if (!person.partyId) return null
  const own = await loadOwnEmploymentIds(db, orgId, authz.user.id)
  if (own.length === 0) return myCompRefusal(authz, 'no-employment')
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
    showEmpty: !hasContent,
    canRequest: true,
    emptyTitle: t('myComp.emptyTitle'),
    emptyDescription: t('myComp.emptyDescription'),
    refusal: null,
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

/**
 * The /me/compensation page state for a login with no employment: the
 * named refusal with its remedy, carried as page state for the house
 * empty-state block (same as /me, documents, surveys and the clock) —
 * never an ambiguous 404. Two causes: 'no-link' (no person is linked to
 * the login; remedy: Link person) and 'no-employment' (a person is
 * linked but has no employment on record; remedy: create it). The
 * request widget stays off (canRequest false): with no employment there
 * is nothing to file against.
 */
export async function myCompRefusal(authz: Authz, cause: 'no-link' | 'no-employment' = 'no-link'): Promise<MyCompData> {
  const t = await getTranslations('hrm')
  const { meTabs } = await import('./self-service')
  const tabs = (await meTabs(authz, '/me/compensation')).map((tab) => ({
    href: tab.href,
    label: tab.label,
    active: tab.active === true,
  }))
  return {
    title: t('myComp.title'),
    description: t('myComp.description'),
    employmentId: '',
    tabs,
    hasContent: false,
    showEmpty: false,
    canRequest: false,
    emptyTitle: t('myComp.emptyTitle'),
    emptyDescription: t('myComp.emptyDescription'),
    refusal: {
      title: t('me.refusedTitle'),
      message: t(cause === 'no-employment' ? 'myComp.noEmployment' : 'myComp.notLinked'),
    },
    placementLabel: t('myComp.placement'),
    placement: '',
    compaRatio: null,
    bandRange: null,
    statementsTitle: t('myComp.statementsTitle'),
    statementsColumns: { period: t('myComp.columns.period'), generated: t('myComp.columns.generated') },
    statements: [],
    statementsEmpty: t('myComp.statementsEmpty'),
    requestLabel: t('myComp.requestPayInfo'),
    requestHref: '',
    requestFailed: t('myComp.requestFailed'),
    requestSubmit: t('myComp.requestSubmit'),
    requestCancel: t('myComp.requestCancel'),
    requestStatus: null,
  }
}

export async function compensationAuthz(): Promise<Authz | null> {
  return getAuthz()
}
