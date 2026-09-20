import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { getHeadcountAsOf } from '@openbooks/engine/src/hrm/employment-read.ts'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import { HrmChangeRequestError, listChangeRequests } from '@openbooks/engine/src/hrm/change-requests.ts'
import { can, type Authz } from '../authz'
import { subsidiaryVisibleFilter } from '../subsidiaries'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../components/module-home/ui'
import { loadQueueLabels } from './change-requests'

/**
 * Human Resources module home — one read for the workspace landing cockpit:
 * headcount as-of today by employer subsidiary and department from the
 * canonical HRM read service, plus the live directory. No direct table
 * reads: every figure comes from getHeadcountAsOf, which resolves each
 * employment through the temporal primitives under the hrm gate and the
 * actor's subsidiary scope.
 */

export interface HrmHeadcountGroup {
  subsidiary: string
  department: string | null
  headcount: number
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

export interface HrmHomeData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  canCreateEmployee: boolean
  newEmployee: { basePath: string; role: 'employee'; label: string }
  headcountLabel: string
  headcountValue: string
  headcountSub: string
  employersLabel: string
  employersValue: string
  employersSub: string
  departmentsLabel: string
  departmentsValue: string
  departmentsSub: string
  pendingLabel: string
  pendingValue: string
  pendingSub: string
  groupsTitle: string
  employerColumn: string
  departmentColumn: string
  headcountColumn: string
  unassigned: string
  groupsEmpty: string
  totalLabel: string
  groups: HrmHeadcountGroup[]
  total: number
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
  readinessTitle: string
  readinessMessage: string
  readinessDocHref: string
  readinessDocLabel: string
  readinessTone: 'warning' | 'positive'
  actionsTitle: string
  actions: DirectoryItem[]
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

function requestKindLabel(t: Awaited<ReturnType<typeof getTranslations<'hrm'>>>, kind: string): string {
  if (kind === 'hire') return t('employment.changeRequests.kindHire')
  if (kind === 'status_change') return t('employment.changeRequests.kindStatusChange')
  if (kind === 'assignment_change') return t('employment.changeRequests.kindAssignmentChange')
  if (kind === 'termination') return t('employment.changeRequests.kindTermination')
  return kind
}

function requestStatusLabel(t: Awaited<ReturnType<typeof getTranslations<'hrm'>>>, status: string): string {
  return t.has(`employment.changeRequests.statusNames.${status}`)
    ? t(`employment.changeRequests.statusNames.${status}`)
    : status
}

function changeKindLabel(t: Awaited<ReturnType<typeof getTranslations<'hrm'>>>, kind: string): string {
  return t.has(`overview.changes.kinds.${kind}`) ? t(`overview.changes.kinds.${kind}`) : kind
}

export async function loadHrmHome(authz: Authz): Promise<HrmHomeData> {
  // The caller (the /hrm view) owns the page gate — requirePermission plus
  // the hrm switch with a 404. This loader never re-checks either; it
  // resolves figures for the authorized session it is given.
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')
  const tNav = await getTranslations('nav')

  const effectiveDate = await businessToday(orgId)
  const knownAt = new Date().toISOString()
  const headcount = await getHeadcountAsOf({ orgId, actorId: authz.user.id, effectiveDate, knownAt })

  const employers = new Set(headcount.groups.map((group) => group.employerSubsidiaryId)).size
  const departments = new Set(
    headcount.groups.map((group) => group.departmentId).filter((id): id is string => id !== null),
  ).size

  // The home reflects the org's own surface: the directory names the native
  // employee list (the module's record home) exactly when the viewer may
  // open it, annotated with the live headcount figure — plus the sibling
  // workspace tabs the viewer may open.
  const directory: DirectoryItem[] = []
  if (can(authz, 'parties.read')) {
    directory.push({
      href: '/entities/employees',
      label: tNav('modules.employees'),
      iconKey: 'clipboard-check',
      badge: { value: String(headcount.total), tone: 'neutral' },
    })
  }
  directory.push({
    href: '/hrm/change-requests',
    label: t('home.tabs.changeRequests'),
    iconKey: 'scroll-text',
  })
  directory.push({
    href: '/hrm/departments',
    label: t('home.tabs.departments'),
    iconKey: 'building',
  })
  if (can(authz, 'reports.read')) {
    directory.push({
      href: '/hrm/reports',
      label: t('home.tabs.reports'),
      iconKey: 'file',
    })
  }

  // Pending change requests through the existing service (newest first,
  // per-row scope inside). A mixed-scope actor is refused rather than
  // shown a partial queue: the refusal renders as data beside the hero,
  // never a 500 and never a silent subset.
  let pendingRefusal: string | null = null
  let pendingCount = 0
  let pending: PendingRequestItem[] = []
  try {
    const queueRows = await listChangeRequests({ orgId, actorId: authz.user.id, limit: HOME_QUEUE_LIMIT })
    const awaiting = queueRows.filter((row) => row.status === 'pending_approval')
    pendingCount = awaiting.length
    const shown = awaiting.slice(0, HOME_PENDING_SHOWN)
    const { workerByEmployment } = await loadQueueLabels(
      orgId,
      [...new Set(shown.map((row) => row.employmentId))],
      [],
    )
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
  } catch (error) {
    if (error instanceof HrmAuthorizationError || error instanceof HrmChangeRequestError) {
      pendingRefusal = (error as Error).message
    } else {
      throw error
    }
  }

  // Starts and ends in the next 30 days from the live employment versions
  // — no engine service exposes an org-wide version listing, so one
  // clearly-scoped loader query reads recorded-live rows in the window,
  // org-predicated and employer-scope filtered. Date arithmetic stays in
  // SQL off the org business day; the loader does no JS date math.
  // Probation ends are not modeled (versions carry status and the
  // effective window only), and the panel says so instead of implying it.
  const employmentScope = subsidiaryVisibleFilter(sql`w.employer_subsidiary_id`, authz.allowedSubsidiaryIds)
  const windowRows = (await db.execute<{
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
             and ev.effective_from <= (${effectiveDate}::date + ${HOME_WINDOW_DAYS}))
         or (ev.effective_to > ${effectiveDate}::date
             and ev.effective_to <= (${effectiveDate}::date + ${HOME_WINDOW_DAYS})))
     order by ev.effective_from
     limit ${HOME_WINDOW_LIMIT}`)).rows
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
  const changeRows = (await db.execute<{
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
     limit ${HOME_RECENT_LIMIT}`)).rows
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
  const unmigratedRows = (await db.execute<{ n: unknown }>(sql`
    select count(*) as n
      from parties p
      join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
     where p.org_id = ${orgId}::uuid and p.is_active
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })}
       and not exists (
         select 1 from worker_employments w
          where w.org_id = p.org_id and w.worker_party_id = p.id
            ${subsidiaryVisibleFilter(sql`w.employer_subsidiary_id`, authz.allowedSubsidiaryIds)}
       )`)).rows
  const unmigrated = Number(unmigratedRows[0]?.n ?? 0)

  // Quick actions, each gated by the permission its target enforces: the
  // New button in the header owns employee creation, this rail owns the
  // propose entry point plus the management surfaces.
  const canManageHrm = can(authz, 'hrm.employment.manage')
  const actions: DirectoryItem[] = []
  if (canManageHrm) {
    actions.push({ href: '/hrm/change-requests', label: t('overview.actions.proposeChange'), iconKey: 'scroll-text' })
  }
  actions.push({ href: '/admin/setup/departments', label: t('overview.actions.manageDepartments'), iconKey: 'building' })
  if (can(authz, 'reports.read')) {
    actions.push({ href: '/hrm/reports', label: t('overview.actions.openReports'), iconKey: 'file' })
  }

  return {
    title: t('home.title'),
    description: t('home.description'),
    tabs: await hrmGroupTabs(authz, '/hrm'),
    canCreateEmployee: can(authz, 'parties.manage'),
    newEmployee: { basePath: '/entities/employees', role: 'employee', label: t('overview.actions.newEmployee') },
    headcountLabel: t('home.vitals.headcount'),
    headcountValue: String(headcount.total),
    headcountSub: t('home.vitals.headcountSub', { date: headcount.effectiveDate }),
    employersLabel: t('home.vitals.employers'),
    employersValue: String(employers),
    employersSub: t('home.vitals.employersSub', { count: employers }),
    departmentsLabel: t('home.vitals.departments'),
    departmentsValue: String(departments),
    departmentsSub: t('home.vitals.departmentsSub', { count: departments }),
    pendingLabel: t('overview.pending.label'),
    pendingValue: pendingRefusal !== null ? '—' : String(pendingCount),
    pendingSub: t('overview.pending.sub'),
    groupsTitle: t('home.groups.title'),
    employerColumn: t('home.groups.employer'),
    departmentColumn: t('home.groups.department'),
    headcountColumn: t('home.groups.headcount'),
    unassigned: t('home.groups.unassigned'),
    groupsEmpty: t('home.groups.empty', { date: headcount.effectiveDate }),
    totalLabel: t('home.groups.total'),
    groups: headcount.groups.map((group) => ({
      subsidiary: group.employerSubsidiaryName,
      department: group.departmentName,
      headcount: group.headcount,
    })),
    total: headcount.total,
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
    upcomingTruncatedNote: t('overview.upcoming.truncatedNote', { limit: HOME_WINDOW_LIMIT }),
    starts,
    ends,
    recentTitle: t('overview.recent.title'),
    recentEmpty: t('overview.recent.empty'),
    recent,
    queueNotAvailable: t('queue.notAvailable'),
    readinessTitle: t('overview.readiness.title'),
    readinessMessage:
      unmigrated === 0
        ? t('overview.readiness.healthy')
        : t('overview.readiness.unmigrated', { count: unmigrated }),
    readinessDocHref: '/docs/employment-migration',
    readinessDocLabel: t('overview.readiness.docLabel'),
    readinessTone: unmigrated === 0 ? 'positive' : 'warning',
    actionsTitle: t('overview.actions.title'),
    actions,
  }
}
