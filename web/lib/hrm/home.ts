import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { getHeadcountAsOf, getHeadcountTotalsAsOf } from '@openbooks/engine/src/hrm/employment-read.ts'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import { HrmChangeRequestError, listChangeRequests } from '@openbooks/engine/src/hrm/change-requests.ts'
import { getVacancyAsOf } from '@openbooks/engine/src/hrm/positions-read.ts'
import { loadRecruitingOverview } from '@openbooks/engine/src/hrm/recruiting/recruiting-read.ts'
import { getOnboardingOverview } from '@openbooks/engine/src/hrm/processes-read.ts'
import { getLocale } from 'next-intl/server'
import { can, type Authz } from '../authz'
import { isFeatureEnabled } from '../features'
import { isMultiSubsidiary, subsidiaryVisibleFilter } from '../subsidiaries'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../components/module-home/ui'
import { loadQueueLabels } from './change-requests'
import { loadLeavePanel, type LeavePanelData } from './leave'
import { loadBenefitsPanel, type BenefitsPanelData } from './benefits'
import { loadQualificationAttention } from './qualifications'

/**
 * Human Resources module home — one read for the workspace landing cockpit:
 * headcount as-of today by employer subsidiary and department from the
 * canonical HRM read service, plus the live directory. No direct table
 * reads: every figure comes from getHeadcountAsOf, which resolves each
 * employment through the temporal primitives under the hrm gate and the
 * actor's subsidiary scope.
 */

export interface HrmHeadcountGroup {
  /** Stable row key for the shared table block; resolved by loaders that render one. */
  id?: string
  subsidiary: string
  department: string | null
  /** Department display value with the unassigned fallback resolved. */
  departmentLabel?: string
  headcount: number
  /** Locale-formatted headcount; the table renders strings, never raw numbers. */
  headcountLabel?: string
  /** Employee-directory drill-through for the row (departments board). */
  href?: string | null
}

export interface PendingRequestItem {
  id: string
  employeeName: string | null
  partyId: string | null
  kindLabel: string
  statusLabel: string
  effectiveLabel: string
}

export interface UpcomingChangeItem {
  name: string | null
  partyId: string | null
  detail: string
}

export interface RecentChangeItem {
  name: string | null
  partyId: string | null
  kindLabel: string
  reason: string
  recordedAt: string
}

export interface HrmVacancyGroup {
  /** Stable row key: the employer/department pair the engine grouped by. */
  id: string
  department: string
  employer: string
  positions: number
  plannedFte: string
  fundedFte: string
  filledFte: string
  vacantFte: string
}

export interface HrmPositionsSummary {
  openPositionsLabel: string
  openPositionsValue: string
  openPositionsSub: string
  /** Filled FTE with no funding behind it; surfaces in the attention list, never as a tile. */
  unfundedFteValue: string
  vacancyTitle: string
  departmentColumn: string
  employerColumn: string
  positionsColumn: string
  plannedColumn: string
  fundedColumn: string
  filledColumn: string
  vacantColumn: string
  vacancyEmpty: string
  totalLabel: string
  unassignedDepartment: string
  groups: HrmVacancyGroup[]
  totals: {
    positions: number
    plannedFte: string
    fundedFte: string
    filledFte: string
    vacantFte: string
  }
}

export interface HrmOnboardingPanelData {
  openCount: number
  overdue: { worker: string; title: string; dueOn: string }[]
  upcoming: { worker: string; title: string; dueOn: string }[]
  panelTitle: string
  openLabel: string
  overdueLabel: string
  upcomingLabel: string
  empty: string
  viewAll: string
  viewAllHref: string
}

export interface HrmRecruitingPanelData {
  panelTitle: string
  openLabel: string
  openValue: string
  awaitingLabel: string
  awaitingValue: string
  interviewsLabel: string
  interviewsValue: string
  viewAll: string
  viewAllHref: string
}

export interface HrmHomeData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  canCreateEmployee: boolean
  canProposeChange: boolean
  canCreateProcess: boolean
  newEmployee: { basePath: string; role: 'employee'; label: string }
  newProcessLabel: string
  /** Present exactly when the viewer holds hrm.process.read; otherwise the rail stays headcount-only. */
  onboarding: HrmOnboardingPanelData | null
  /** Whether the org runs more than one subsidiary; the subsidiary column
   *  and grouping render only then — a single-entity org sees departments. */
  multiSubsidiary: boolean
  headcountLabel: string
  headcountValue: string
  headcountSub: string
  pendingLabel: string
  pendingValue: string
  pendingSub: string
  pendingAccent: 'amber' | 'emerald'
  startingLabel: string
  startingValue: string
  startingSub: string
  /** On leave today; null without the leave grant (the tile is omitted). */
  onLeaveLabel: string | null
  onLeaveValue: string
  onLeaveSub: string
  trendTitle: string
  trendHint: string
  trendSeriesName: string
  trendLabels: string[]
  trendData: number[]
  attentionTitle: string
  attentionAllClear: string
  attention: { tone: 'negative' | 'warning'; text: string; href: string }[]
  groupsTitle: string
  employerColumn: string
  departmentColumn: string
  headcountColumn: string
  unassigned: string
  groupsEmpty: string
  totalLabel: string
  groups: HrmHeadcountGroup[]
  total: number
  /** Locale-formatted total; the table renders strings, never raw numbers. */
  totalValue: string
  directoryTitle: string
  directory: DirectoryItem[]
  pendingTitle: string
  pendingEmpty: string
  pendingViewAll: string
  pendingQueueHref: string
  pendingRefusal: string | null
  pending: PendingRequestItem[]
  upcomingTitle: string
  upcomingHint: string
  startsTitle: string
  startsEmpty: string
  endsTitle: string
  endsEmpty: string
  upcomingTruncated: boolean
  upcomingTruncatedNote: string
  starts: UpcomingChangeItem[]
  ends: UpcomingChangeItem[]
  recentTitle: string
  recentEmpty: string
  recent: RecentChangeItem[]
  queueNotAvailable: string
  actionsTitle: string
  actions: DirectoryItem[]
  /** Headcount-plan summary; null when the viewer lacks hrm.position.read. */
  positions: HrmPositionsSummary | null
  leavePanel: LeavePanelData | null
  /** Recruiting figures; null without hrm.recruiting.read. */
  recruiting: HrmRecruitingPanelData | null
  /** Open windows, pending approvals, months missing inputs; null without hrm.benefits.read. */
  benefitsPanel: BenefitsPanelData | null
}

/**
 * Bounded reads beside the headcount hero. The pending queue mirrors the
 * queue page's own bound so the two counts can never disagree about what
 * was fetched; the upcoming window is capped defensively (a 30-day window
 * is naturally small).
 */
const HOME_QUEUE_LIMIT = 500
const HOME_PENDING_SHOWN = 5
const HOME_WINDOW_DAYS = 30
const HOME_WINDOW_LIMIT = 100
const HOME_RECENT_LIMIT = 10

/** The last civil day of each of the `count` months before the month of `date`, oldest first. */
export function monthEndsBefore(date: string, count: number): string[] {
  const [year, month] = date.split('-').map(Number) as [number, number, number]
  const out: string[] = []
  for (let back = count; back >= 1; back -= 1) {
    // Day 0 of month m is the last day of month m-1 (UTC arithmetic only).
    const end = new Date(Date.UTC(year, month - 1 - back + 1, 0))
    out.push(end.toISOString().slice(0, 10))
  }
  return out
}

function requestKindLabel(t: Awaited<ReturnType<typeof getTranslations<'hrm'>>>, kind: string): string {
  if (kind === 'hire') return t('employment.changeRequests.kindHire')
  if (kind === 'status_change') return t('employment.changeRequests.kindStatusChange')
  if (kind === 'assignment_change') return t('employment.changeRequests.kindAssignmentChange')
  if (kind === 'termination') return t('employment.changeRequests.kindTermination')
  return kind
}

function requestStatusLabel(t: Awaited<ReturnType<typeof getTranslations<'hrm'>>>, status: string): string {
  return t.has(`employment.changeRequests.statusNames.${status}`) ? t(`employment.changeRequests.statusNames.${status}`) : status
}

function changeKindLabel(t: Awaited<ReturnType<typeof getTranslations<'hrm'>>>, kind: string): string {
  return t.has(`overview.changes.kinds.${kind}`) ? t(`overview.changes.kinds.${kind}`) : kind
}

export async function loadHrmHome(authz: Authz): Promise<HrmHomeData> {
  // The caller (the /hrm view) owns the page gate — requirePermission plus
  // the hrm switch with a 404. This loader never re-checks either; it
  // resolves figures for the authorized session it is given.
  const orgId = authz.user.orgId
  const [t, tNav, effectiveDate, locale] = await Promise.all([
    getTranslations('hrm'),
    getTranslations('nav'),
    businessToday(orgId),
    getLocale(),
  ])
  const knownAt = new Date().toISOString()
  const trendDates = monthEndsBefore(effectiveDate, 11).concat([effectiveDate])
  const historicalDates = trendDates.filter((date) => date !== effectiveDate)
  const canReadPositions = can(authz, 'hrm.position.read')
  const canReadProcesses = can(authz, 'hrm.process.read')
  const canReadLeave = can(authz, 'hrm.leave.read')
  const canManageHrm = can(authz, 'hrm.employment.manage')
  const employmentScope = subsidiaryVisibleFilter(sql`w.employer_subsidiary_id`, authz.allowedSubsidiaryIds)

  // Every cockpit panel is an independent read under the same authenticated
  // view. Start them together so a remote tenant database pays the slowest
  // panel's latency, not the sum of every panel. Each underlying service
  // retains its own gate, permission, tenant scope, and refusal behavior.
  const [
    headcount,
    historicalHeadcount,
    multiSubsidiary,
    vacancy,
    queueLoad,
    windowResult,
    changeResult,
    unmigratedResult,
    onboarding,
    leavePanel,
    recruiting,
    qualificationAttention,
    tabs,
    benefitsPanel,
  ] = await Promise.all([
    getHeadcountAsOf({ orgId, actorId: authz.user.id, effectiveDate, knownAt }),
    getHeadcountTotalsAsOf({ orgId, actorId: authz.user.id, effectiveDates: historicalDates, knownAt }),
    isMultiSubsidiary(orgId),
    canReadPositions
      ? getVacancyAsOf({ orgId, actorId: authz.user.id, effectiveDate, knownAt })
      : Promise.resolve(null),
    (async () => {
      try {
        return {
          rows: await listChangeRequests({ orgId, actorId: authz.user.id, limit: HOME_QUEUE_LIMIT }),
          refusal: null as string | null,
        }
      } catch (error) {
        if (error instanceof HrmAuthorizationError || error instanceof HrmChangeRequestError) {
          return { rows: [], refusal: (error as Error).message }
        }
        throw error
      }
    })(),
    db.execute<{
      employmentId: string
      name: string | null
      partyId: string | null
      status: string
      from: string
      to: string | null
    }>(sql`
      select w.id::text as "employmentId", p.display_name as name, p.id::text as "partyId",
             ev.status as status,
             ev.effective_from::text as "from", ev.effective_to::text as "to"
        from worker_employment_versions ev
        join worker_employments w on w.id = ev.employment_id and w.org_id = ev.org_id
        join parties p on p.id = w.worker_party_id and p.org_id = w.org_id
       where ev.org_id = ${orgId}::uuid
         and ev.recorded_until is null
         ${employmentScope}
         and ((ev.effective_from > ${effectiveDate}::date
               and ev.effective_from <= (${effectiveDate}::date + ${HOME_WINDOW_DAYS}::int))
           or (ev.effective_to > ${effectiveDate}::date
               and ev.effective_to <= (${effectiveDate}::date + ${HOME_WINDOW_DAYS}::int)))
       order by ev.effective_from
       limit ${HOME_WINDOW_LIMIT}`),
    db.execute<{
      kind: string
      reason: string
      recordedAt: string
      name: string | null
      partyId: string | null
    }>(sql`
      select c.change_kind as kind, c.reason as reason,
             to_char(c.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt",
             p.display_name as name, p.id::text as "partyId"
        from employment_changes c
        join worker_employments w on w.id = c.employment_id and w.org_id = c.org_id
        join parties p on p.id = w.worker_party_id and p.org_id = w.org_id
       where c.org_id = ${orgId}::uuid
         ${employmentScope}
       order by c.recorded_at desc
       limit ${HOME_RECENT_LIMIT}`),
    db.execute<{ n: unknown }>(sql`
      select count(*) as n
        from parties p
        join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
       where p.org_id = ${orgId}::uuid and p.is_active
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
         and not exists (
           select 1 from worker_employments w
            where w.org_id = p.org_id and w.worker_party_id = p.id
              ${subsidiaryVisibleFilter(sql`w.employer_subsidiary_id`, authz.allowedSubsidiaryIds)}
         )`),
    canReadProcesses
      ? getOnboardingOverview({ orgId, actorId: authz.user.id }).then((overview) => ({
          openCount: overview.openProcesses.length,
          overdue: overview.overdueSteps.map((step) => ({ worker: step.workerName, title: step.title, dueOn: step.dueOn })),
          upcoming: overview.dueNextSevenDays.map((step) => ({ worker: step.workerName, title: step.title, dueOn: step.dueOn })),
          panelTitle: t('home.onboarding.title'),
          openLabel: t('home.onboarding.openLabel'),
          overdueLabel: t('home.onboarding.overdueLabel'),
          upcomingLabel: t('home.onboarding.upcomingLabel'),
          empty: t('home.onboarding.empty'),
          viewAll: t('home.onboarding.viewAll'),
          viewAllHref: '/hrm/processes',
        }))
      : Promise.resolve(null),
    loadLeavePanel(authz),
    loadRecruitingPanel(authz),
    loadQualificationAttention(authz),
    hrmGroupTabs(authz, '/hrm'),
    loadBenefitsPanel(authz),
  ])

  // Twelve month-end headcounts through the same canonical temporal read,
  // ending on today. Historical points share one authorized census and one
  // known-at view, so latency stays constant as the chart grows and the
  // series still agrees with the grouped hero to the person.
  const totalByDate = new Map(historicalHeadcount.points.map((point) => [point.effectiveDate, point.total]))
  totalByDate.set(effectiveDate, headcount.total)
  const trendData = trendDates.map((date) => {
    const total = totalByDate.get(date)
    if (total === undefined) throw new Error(`Headcount series did not resolve ${date}; refusing to render a false zero`)
    return total
  })
  const trendLabels = trendDates.map((date) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
      month: 'short',
      timeZone: 'UTC',
    }),
  )
  // FTE is stored at four places (numeric(19,4)); the cockpit shows it as a
  // person-readable figure, at most two decimals in the viewer's locale.
  const fte = (value: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(value))

  // The headcount plan rides the same cockpit when the viewer holds the
  // position read grant: open establishments, unfunded filled FTE, and the
  // vacancy-by-department breakdown, all resolved through the canonical
  // position read service. Without the grant the cockpit shows no
  // positions section at all — never a gated link.
  let positions: HrmPositionsSummary | null = null
  if (vacancy !== null) {
    const openCount = vacancy.positions.filter((row) => row.version.status === 'open').length
    const unassignedDepartment = t('home.vacancy.unassignedDepartment')
    positions = {
      openPositionsLabel: t('home.vitals.openPositions'),
      openPositionsValue: String(openCount),
      openPositionsSub: t('home.vitals.openPositionsSub', {
        fte: fte(vacancy.totals.vacantFte),
      }),
      unfundedFteValue: vacancy.totals.unfundedFilledFte,
      vacancyTitle: t('home.vacancy.title'),
      departmentColumn: t('home.vacancy.department'),
      employerColumn: t('home.vacancy.employer'),
      positionsColumn: t('home.vacancy.positions'),
      plannedColumn: t('home.vacancy.planned'),
      fundedColumn: t('home.vacancy.funded'),
      filledColumn: t('home.vacancy.filled'),
      vacantColumn: t('home.vacancy.vacant'),
      vacancyEmpty: t('home.vacancy.empty', { date: vacancy.effectiveDate }),
      totalLabel: t('home.vacancy.total'),
      unassignedDepartment,
      groups: vacancy.byDepartment.map((group) => ({
        id: `${group.employerSubsidiaryName} / ${group.departmentName ?? ''}`,
        department: group.departmentName ?? unassignedDepartment,
        employer: group.employerSubsidiaryName,
        positions: group.positions,
        plannedFte: fte(group.plannedFte),
        fundedFte: fte(group.fundedFte),
        filledFte: fte(group.filledFte),
        vacantFte: fte(group.vacantFte),
      })),
      totals: {
        positions: vacancy.totals.positions,
        plannedFte: fte(vacancy.totals.plannedFte),
        fundedFte: fte(vacancy.totals.fundedFte),
        filledFte: fte(vacancy.totals.filledFte),
        vacantFte: fte(vacancy.totals.vacantFte),
      },
    }
  }

  // The home reflects the org's own surface: the directory names the native
  // employee list (the module's record home) exactly when the viewer may
  // open it, annotated with the live headcount figure — plus the sibling
  // workspace tabs the viewer may open. The change-request queue is NOT a
  // destination here: it is reached from the pending panel below and from
  // the employee drawer, by review. Departments are configured in Company
  // setup and workforce reports live in the Reports module (quick actions).
  // Pending change requests through the existing service (newest first,
  // per-row scope inside). A mixed-scope actor is refused rather than
  // shown a partial queue: the refusal renders as data beside the hero,
  // never a 500 and never a silent subset.
  const pendingRefusal = queueLoad.refusal
  let pendingCount = 0
  let pending: PendingRequestItem[] = []
  if (pendingRefusal === null) {
    const awaiting = queueLoad.rows.filter((row) => row.status === 'pending_approval')
    pendingCount = awaiting.length
    const shown = awaiting.slice(0, HOME_PENDING_SHOWN)
    const { workerByEmployment } = await loadQueueLabels(orgId, [...new Set(shown.map((row) => row.employmentId))], [])
    const present = t('employment.episodes.present')
    pending = shown.map((row) => {
      const worker = workerByEmployment.get(row.employmentId)
      const payload = row.payload as { kind: string } & Record<string, unknown>
      const from =
        typeof payload.effectiveFrom === 'string'
          ? payload.effectiveFrom
          : typeof payload.effectiveDate === 'string'
            ? payload.effectiveDate
            : null
      const to = typeof payload.effectiveTo === 'string' ? payload.effectiveTo : null
      return {
        id: row.id,
        employeeName: worker?.name ?? null,
        partyId: worker?.partyId ?? null,
        kindLabel: requestKindLabel(t, payload.kind),
        statusLabel: requestStatusLabel(t, row.status),
        effectiveLabel: from === null ? t('queue.notAvailable') : `${from} → ${to ?? present}`,
      }
    })
  }

  // Starts and ends in the next 30 days from the live employment versions
  // — no engine service exposes an org-wide version listing, so one
  // clearly-scoped loader query reads recorded-live rows in the window,
  // org-predicated and employer-scope filtered. Date arithmetic stays in
  // SQL off the org business day; the loader does no JS date math.
  // The window length is bound with an explicit ::int: a bare bound number
  // reaches PostgreSQL as an untyped parameter, and `date + unknown` is
  // ambiguous (integer days or an interval) — the query that took the HRM
  // overview down in production on alpha.19.
  // Probation ends are not modeled (versions carry status and the
  // effective window only), and the panel says so instead of implying it.
  const windowRows = windowResult.rows
  const upcomingTruncated = windowRows.length >= HOME_WINDOW_LIMIT
  const starts: UpcomingChangeItem[] = []
  const ends: UpcomingChangeItem[] = []
  for (const row of windowRows) {
    const fromInWindow = row.from > effectiveDate
    // An end is a version whose window closes in the period, or a
    // termination taking effect in it; anything else starting in the
    // period is a start. A row matching both lists once, as an end.
    const isEnd = !fromInWindow || row.status === 'terminated'
    const item: UpcomingChangeItem = {
      name: row.name,
      partyId: row.partyId,
      detail: `${isEnd ? (row.to ?? row.from) : row.from} · ${requestStatusLabel(t, row.status)}`,
    }
    if (isEnd) ends.push(item)
    else starts.push(item)
  }

  // Recent employment changes: the last recorded aggregate change events
  // with their reasons — the same clearly-scoped shape (org predicate,
  // employer-scope filter, newest first, bounded).
  const changeRows = changeResult.rows
  const recent: RecentChangeItem[] = changeRows.map((row) => ({
    name: row.name,
    partyId: row.partyId,
    kindLabel: changeKindLabel(t, row.kind),
    reason: row.reason,
    recordedAt: row.recordedAt,
  }))

  // Readiness: active employee parties with no employment record at all.
  // No service exposes the unmigrated set, so one clearly-scoped query
  // counts it — party-side subsidiary visibility plus the employment-side
  // employer scope, so a restricted viewer never counts outside their
  // lens. The sentence names what the number means and headcount's
  // exclusion; the link opens the migration article.
  const unmigratedRows = unmigratedResult.rows
  const unmigrated = Number(unmigratedRows[0]?.n ?? 0)

  // Quick actions, each gated by the permission its target enforces: the
  // New button in the header owns employee creation, this rail owns the
  // propose entry point, self-service leave, and the two surfaces that live
  // in other modules on purpose (departments in Company setup, workforce
  // reports in the Reports module — never a second page of either here).
  const actions: DirectoryItem[] = []
  if (canManageHrm) {
    actions.push({
      href: '/hrm/change-requests',
      label: t('overview.actions.proposeChange'),
      iconKey: 'scroll',
    })
  }
  if (can(authz, 'hrm.leave.request')) {
    actions.push({
      href: '/hrm/my-leave',
      label: t('home.tabs.myLeave'),
      iconKey: 'timer',
    })
  }
  actions.push({
    href: '/admin/setup/departments',
    label: t('overview.actions.manageDepartments'),
    iconKey: 'building',
  })
  if (can(authz, 'reports.read')) {
    actions.push({
      href: '/reports',
      label: t('overview.actions.openReports'),
      iconKey: 'file',
    })
  }

  // Independent onboarding, leave, recruiting, and qualification reads were
  // resolved in the concurrent cockpit wave above. Their null values still
  // mean the viewer lacks the corresponding grant or subordinate feature.
  const leavePending = leavePanel?.pendingCount ?? 0
  const overdueSteps = onboarding?.overdue.length ?? 0
  const openPositions = positions ? Number(positions.openPositionsValue) : 0
  const unfundedFte = positions ? Number(positions.unfundedFteValue) : 0

  // The live directory: the workspace's pages as a work queue, each badge a
  // figure the loader already resolved through the canonical reads.
  const directory: DirectoryItem[] = []
  if (can(authz, 'parties.read')) {
    directory.push({
      href: '/entities/employees',
      label: tNav('modules.employees'),
      iconKey: 'clipboard-check',
      badge: {
        value: String(headcount.total),
        hint: t('home.directory.employeesHint'),
        tone: 'neutral',
      },
    })
  }
  if (canReadPositions) {
    directory.push({
      href: '/hrm/positions',
      label: t('home.tabs.positions'),
      iconKey: 'layers',
      badge: {
        value: String(openPositions),
        hint: t('home.directory.positionsHint'),
        tone: openPositions > 0 ? 'warning' : 'neutral',
      },
    })
  }
  if (canReadProcesses) {
    directory.push({
      href: '/hrm/processes',
      label: t('home.tabs.processes'),
      iconKey: 'list-checks',
      badge: {
        value: String(onboarding?.openCount ?? 0),
        hint: t('home.directory.processesHint', { count: overdueSteps }),
        tone: overdueSteps > 0 ? 'negative' : 'neutral',
      },
    })
  }
  if (recruiting) {
    directory.push({
      href: '/hrm/recruiting',
      label: t('home.tabs.recruiting'),
      iconKey: 'target',
      badge: {
        value: recruiting.openValue,
        hint: t('home.directory.recruitingHint', {
          count: Number(recruiting.awaitingValue),
        }),
        tone: Number(recruiting.awaitingValue) > 0 ? 'warning' : 'neutral',
      },
    })
  }
  if (canReadLeave) {
    directory.push({
      href: '/hrm/leave',
      label: t('home.tabs.timeOff'),
      iconKey: 'timer',
      badge: {
        value: String(leavePanel?.onLeaveToday.length ?? 0),
        hint: t('home.directory.leaveHint', { count: leavePending }),
        tone: leavePending > 0 ? 'warning' : 'neutral',
      },
    })
  }
  if (await isFeatureEnabled(orgId, 'hrmOrgChart')) {
    directory.push({
      href: '/hrm/org-chart',
      label: t('home.tabs.orgChart'),
      iconKey: 'workflow',
    })
  }
  directory.push({
    href: '/hrm/performance',
    label: t('home.tabs.talent'),
    iconKey: 'star',
  })
  if (can(authz, 'hrm.surveys.manage') && (await isFeatureEnabled(orgId, 'hrmSurveys'))) {
    directory.push({
      href: '/hrm/surveys',
      label: t('home.tabs.surveys'),
      iconKey: 'message',
    })
  }
  if (can(authz, 'hrm.compensation.read') && (await isFeatureEnabled(orgId, 'hrmCompensation'))) {
    directory.push({
      href: '/hrm/compensation',
      label: t('home.tabs.compensation'),
      iconKey: 'wallet',
    })
  }
  if (can(authz, 'hrm.benefits.read')) {
    directory.push({
      href: '/hrm/benefits',
      label: t('home.tabs.benefits'),
      iconKey: 'heart-pulse',
    })
  }
  if (can(authz, 'hrm.documents.read') && (await isFeatureEnabled(orgId, 'hrmDocuments'))) {
    directory.push({
      href: '/hrm/documents',
      label: t('home.tabs.documents'),
      iconKey: 'file',
    })
  }
  if (can(authz, 'hrm.certifications.read') && (await isFeatureEnabled(orgId, 'hrmCertifications'))) {
    directory.push({
      href: '/hrm/qualifications',
      label: t('home.tabs.qualifications'),
      iconKey: 'award',
    })
  }
  if (can(authz, 'hrm.construction.read') && (await isFeatureEnabled(orgId, 'hrmConstructionCompliance'))) {
    directory.push({
      href: '/hrm/compliance',
      label: t('home.tabs.compliance'),
      iconKey: 'shield',
    })
  }

  // Needs attention: every figure that asks someone to act, with the page
  // that acts on it. Empty renders the all-clear sentence, never a blank.
  const attention: HrmHomeData['attention'] = []
  if (pendingRefusal === null && pendingCount > 0) {
    attention.push({
      tone: 'warning',
      text: t('home.attention.pending', { count: pendingCount }),
      href: '/hrm/change-requests?status=submitted',
    })
  }
  if (overdueSteps > 0) {
    attention.push({
      tone: 'negative',
      text: t('home.attention.overdueSteps', { count: overdueSteps }),
      href: '/hrm/processes?segment=overdue',
    })
  }
  if (leavePending > 0) {
    attention.push({
      tone: 'warning',
      text: t('home.attention.leavePending', { count: leavePending }),
      href: '/hrm/leave?segment=pending',
    })
  }
  // HR-14 begin: lapsed certifications refuse dispatch, expiring ones
  // warn it — both link into the pre-filtered ledger segment.
  if (qualificationAttention && qualificationAttention.expired > 0) {
    attention.push({
      tone: 'negative',
      text: t('home.attention.expiredQualifications', {
        count: qualificationAttention.expired,
      }),
      href: '/hrm/qualifications?segment=expired',
    })
  }
  if (qualificationAttention && qualificationAttention.expiring > 0) {
    attention.push({
      tone: 'warning',
      text: t('home.attention.expiringQualifications', {
        count: qualificationAttention.expiring,
      }),
      href: '/hrm/qualifications?segment=expiring',
    })
  }
  // HR-14 end
  if (positions && unfundedFte > 0) {
    attention.push({
      tone: 'warning',
      text: t('home.attention.unfunded', {
        fte: fte(positions.unfundedFteValue),
      }),
      href: '/hrm/positions',
    })
  }
  if (unmigrated > 0) {
    attention.push({
      tone: 'warning',
      text: t('overview.readiness.unmigrated', { count: unmigrated }),
      href: '/docs/employment-migration',
    })
  }

  return {
    title: t('home.title'),
    description: t('home.description'),
    tabs,
    multiSubsidiary,
    canCreateEmployee: can(authz, 'parties.manage'),
    canProposeChange: canManageHrm,
    canCreateProcess: can(authz, 'hrm.process.manage') && canReadProcesses,
    newEmployee: {
      basePath: '/entities/employees',
      role: 'employee',
      label: t('overview.actions.newEmployee'),
    },
    newProcessLabel: t('processes.newChecklist'),
    onboarding,
    headcountLabel: t('home.vitals.headcount'),
    headcountValue: String(headcount.total),
    headcountSub: t('home.vitals.headcountSub', {
      date: headcount.effectiveDate,
    }),
    pendingLabel: t('overview.pending.label'),
    pendingValue: pendingRefusal !== null ? '—' : String(pendingCount),
    pendingSub: t('overview.pending.sub'),
    pendingAccent: pendingCount > 0 ? 'amber' : 'emerald',
    startingLabel: t('home.vitals.startingSoon'),
    startingValue: String(starts.length),
    startingSub: t('home.vitals.startingSoonSub', { count: ends.length }),
    onLeaveLabel: leavePanel ? t('home.vitals.onLeave') : null,
    onLeaveValue: String(leavePanel?.onLeaveToday.length ?? 0),
    onLeaveSub: t('home.vitals.onLeaveSub', { count: leavePending }),
    trendTitle: t('home.trend.title'),
    trendHint: t('home.trend.hint'),
    trendSeriesName: t('home.trend.series'),
    trendLabels,
    trendData,
    attentionTitle: t('home.attention.title'),
    attentionAllClear: t('home.attention.allClear'),
    attention,
    groupsTitle: t('home.groups.title'),
    employerColumn: t('home.groups.employer'),
    departmentColumn: t('home.groups.department'),
    headcountColumn: t('home.groups.headcount'),
    unassigned: t('home.groups.unassigned'),
    groupsEmpty: t('home.groups.empty', { date: headcount.effectiveDate }),
    totalLabel: t('home.groups.total'),
    groups: headcount.groups.map((group) => ({
      id: `${group.employerSubsidiaryName} / ${group.departmentName ?? ''}`,
      subsidiary: group.employerSubsidiaryName,
      department: group.departmentName,
      departmentLabel: group.departmentName ?? t('home.groups.unassigned'),
      headcount: group.headcount,
      headcountLabel: group.headcount.toLocaleString(),
    })),
    total: headcount.total,
    totalValue: headcount.total.toLocaleString(),
    directoryTitle: t('home.directory.title'),
    directory,
    pendingTitle: t('overview.pending.title'),
    pendingEmpty: t('overview.pending.empty'),
    pendingViewAll: t('overview.pending.viewAll'),
    pendingQueueHref: '/hrm/change-requests?status=submitted',
    pendingRefusal,
    pending,
    upcomingTitle: t('overview.upcoming.title'),
    upcomingHint: t('overview.upcoming.hint'),
    startsTitle: t('overview.upcoming.startsTitle'),
    startsEmpty: t('overview.upcoming.startsEmpty'),
    endsTitle: t('overview.upcoming.endsTitle'),
    endsEmpty: t('overview.upcoming.endsEmpty'),
    upcomingTruncated,
    upcomingTruncatedNote: t('overview.upcoming.truncatedNote', {
      limit: HOME_WINDOW_LIMIT,
    }),
    starts,
    ends,
    recentTitle: t('overview.recent.title'),
    recentEmpty: t('overview.recent.empty'),
    recent,
    queueNotAvailable: t('queue.notAvailable'),
    actionsTitle: t('overview.actions.title'),
    actions,
    positions,
    // Leave panel: on leave today plus pending approvals, for viewers who
    // may open the Leave tab. Null (no panel) without the leave grant.
    leavePanel,
    recruiting,
    // Benefits panel: open windows, pending approvals, elections missing
    // inputs for the current month. Null without the benefits grant.
    benefitsPanel,
  }
}

/**
 * Recruiting rail panel: open requisitions, offers awaiting response, and
 * interviews this week, resolved through the canonical recruiting read
 * service. Null (no panel) without the recruiting grant — never a gated
 * link.
 */
export async function loadRecruitingPanel(authz: Authz): Promise<HrmRecruitingPanelData | null> {
  if (!can(authz, 'hrm.recruiting.read')) return null
  const t = await getTranslations('hrm')
  const overview = await loadRecruitingOverview({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
  })
  if (!overview) return null
  return {
    panelTitle: t('home.recruiting.title'),
    openLabel: t('home.recruiting.open'),
    openValue: String(overview.openRequisitions),
    awaitingLabel: t('home.recruiting.awaiting'),
    awaitingValue: String(overview.offersAwaitingResponse),
    interviewsLabel: t('home.recruiting.interviews'),
    interviewsValue: String(overview.interviewsThisWeek),
    viewAll: t('home.recruiting.viewAll'),
    viewAllHref: '/hrm/recruiting',
  }
}
