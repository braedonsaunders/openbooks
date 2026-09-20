import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import {
  listLeaveTypes,
  listOrgLeaveRequests,
  myLeaveRequests,
  payrollBankBalances,
  timeBalanceAsOf,
  type LeaveRequestSummary,
} from '@openbooks/engine/src/hrm/leave-read.ts'
import {
  absenceCalendarForDepartment,
  employmentsOnLeave,
} from '@openbooks/engine/src/hrm/attendance.ts'
import { loadOwnEmploymentIds } from '@openbooks/engine/src/hrm/authorization.ts'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import { LeaveError } from '@openbooks/engine/src/hrm/leave-errors.ts'
import { can, type Authz } from '../authz'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { loadQueueLabels } from './change-requests'

/**
 * Leave workspace loaders — one read per surface behind the Leave tab, the
 * self-service inbox, and the overview panel.
 *
 * Rows come from the leave read service (listOrgLeaveRequests, newest start
 * first, per-row employment gate and subsidiary scope inside), never a
 * direct request-table read from the web app. Two display-resolution queries
 * ride beside it — employment→worker names — keyed strictly by ids the
 * service already authorized, with the org predicate on every leg (the
 * shared loadQueueLabels helper, so the two queues cannot resolve names
 * differently). Computed refusals travel as data: the page renders them as
 * refusals beside the segments, never an empty table pretending to be data.
 */

const QUEUE_LIMIT = 500

export interface LeaveQueueRow extends LeaveRequestSummary {
  employeeName: string | null
  partyId: string | null
  /** Display-resolved cells for the shared table block: labels and hrefs, never ids. */
  employeeLabel: string
  employeeHref: string | null
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  requestHref: string
  openLabel: string
  rangeLabel: string
}

export interface LeaveSegment {
  value: string
  label: string
  count: number
}

export interface LeaveRefusal {
  title: string
  message: string
}

export interface LeaveQueueData {
  title: string
  description: string
  listTitle: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  refusal: LeaveRefusal | null
  hasContent: boolean
  segmentsLabel: string
  allLabel: string
  counts: Record<string, number>
  total: number
  truncated: boolean
  truncatedNote: string
  segments: LeaveSegment[]
  currentParams: Record<string, string | string[] | undefined>
  columns: { employee: string; type: string; range: string; hours: string }
  rows: LeaveQueueRow[]
  emptyTitle: string
  emptyDescription: string
  canFile: boolean
  canRecord: boolean
  fileTitle: string
  fileButton: string
  recordTitle: string
  recordButton: string
  calendarTitle: string
  calendarDepartmentLabel: string
  calendarFromLabel: string
  calendarToLabel: string
  calendarShowLabel: string
  calendarDays: { date: string; entries: { workerName: string; hours: string; leaveTypeCode: string }[] }[]
  calendarEmpty: string
  departmentOptions: { value: string; label: string }[]
  queue: { notAvailable: string; openEmployee: string }
  openRequest: string
  fileHref: string
  recordHref: string
  dialogOpen: boolean
  dialogRequestId: string | null
  dialogCloseHref: string
}

function segmentOf(row: LeaveRequestSummary, today: string): 'pending' | 'upcoming' | 'today' | 'history' {
  if (row.status === 'submitted') return 'pending'
  if (row.status === 'approved' && row.endsOn >= today) return 'upcoming'
  return 'history'
}

type LeaveCatalog = {
  (key: string, params?: Record<string, string | number>): string
  has: (key: string) => boolean
}

/** Header/dialog hrefs preserve the active segment; the dialog closes by navigating the param away. */
function leaveHref(
  basePath: string,
  segment: string | undefined,
  extra: Record<string, string>,
): string {
  const params = new URLSearchParams()
  if (segment) params.set('segment', segment)
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

function leaveStatusLabel(t: LeaveCatalog, status: string): string {
  return t.has(`leave.statusNames.${status}`) ? t(`leave.statusNames.${status}`) : status
}

function leaveStatusVariant(status: string): LeaveQueueRow['statusVariant'] {
  if (status === 'draft') return 'secondary'
  if (status === 'submitted') return 'warning'
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'destructive'
  if (status === 'withdrawn' || status === 'cancelled') return 'outline'
  return 'default'
}

export async function loadLeaveQueue(
  authz: Authz,
  sp: Record<string, string | undefined>,
): Promise<LeaveQueueData> {
  // The caller (the leave view) owns the page gate — requirePermission plus
  // the hrm switch with a 404. This loader never re-checks either; it
  // resolves rows for the authorized session it is given.
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')
  const today = await businessToday(orgId)
  const base = {
    title: t('leave.title'),
    description: t('leave.description'),
    listTitle: t('leave.listTitle'),
    tabs: await hrmGroupTabs(authz, '/hrm/leave'),
    segmentsLabel: t('leave.segmentsLabel'),
    allLabel: t('leave.allLabel'),
    columns: {
      employee: t('leave.columns.employee'),
      type: t('leave.columns.type'),
      range: t('leave.columns.range'),
      hours: t('leave.columns.hours'),
    },
    emptyTitle: t('leave.emptyTitle'),
    emptyDescription: t('leave.emptyDescription'),
    truncatedNote: t('leave.truncatedNote', { limit: QUEUE_LIMIT }),
    canFile: can(authz, 'hrm.leave.request') || can(authz, 'hrm.leave.manage'),
    canRecord: can(authz, 'hrm.leave.manage'),
    fileTitle: t('leave.fileTitle'),
    fileButton: t('leave.fileButton'),
    recordTitle: t('leave.recordTitle'),
    recordButton: t('leave.recordButton'),
    calendarTitle: t('leave.calendarTitle'),
    calendarDepartmentLabel: t('leave.calendarDepartmentLabel'),
    calendarFromLabel: t('leave.calendarFromLabel'),
    calendarToLabel: t('leave.calendarToLabel'),
    calendarShowLabel: t('leave.calendarShowLabel'),
    calendarEmpty: t('leave.calendarEmpty'),
    queue: { notAvailable: t('queue.notAvailable'), openEmployee: t('queue.openEmployee') },
    currentParams: sp as Record<string, string | string[] | undefined>,
    openRequest: t('leave.openRequest'),
    fileHref: leaveHref('/hrm/leave', sp.segment, { file: '1' }),
    recordHref: leaveHref('/hrm/leave', sp.segment, { record: '1' }),
    dialogOpen: sp.file !== undefined || sp.record !== undefined || (typeof sp.request === 'string' && sp.request !== ''),
    dialogRequestId: typeof sp.request === 'string' && sp.request !== '' ? sp.request : null,
    dialogCloseHref: leaveHref('/hrm/leave', sp.segment, {}),
  }

  const segmentParam = sp.segment
  if (segmentParam !== undefined && !['pending', 'upcoming', 'today', 'history'].includes(segmentParam)) {
    return {
      ...base,
      refusal: { title: t('leave.unknownSegmentTitle'), message: t('leave.unknownSegment', { segment: segmentParam }) },
      hasContent: false,
      counts: {},
      total: 0,
      truncated: false,
      segments: [],
      rows: [],
      departmentOptions: [],
      calendarDays: [],
    }
  }

  let listed: LeaveRequestSummary[]
  let truncated = false
  try {
    const result = await listOrgLeaveRequests(db, orgId, authz.user.id, { limit: QUEUE_LIMIT })
    listed = result.requests
    truncated = result.truncated
  } catch (error) {
    const message = error instanceof HrmAuthorizationError || error instanceof LeaveError ? error.message : null
    return {
      ...base,
      refusal: message
        ? { title: t('leave.refusedTitle'), message }
        : null,
      hasContent: message === null,
      counts: {},
      total: 0,
      truncated: false,
      segments: [],
      rows: [],
      departmentOptions: [],
      calendarDays: [],
    }
  }

  // On-leave-today is absence-fact, not request state: approved days land
  // here even when the request range started earlier.
  const onLeave = await employmentsOnLeave(db, orgId, today)
  const onLeaveEmploymentIds = new Set(onLeave.map((entry) => entry.employmentId))

  const counts: Record<string, number> = { pending: 0, upcoming: 0, today: onLeave.length, history: 0 }
  for (const row of listed) counts[segmentOf(row, today)] = (counts[segmentOf(row, today)] ?? 0) + 1
  const segments: LeaveSegment[] = (['pending', 'upcoming', 'today', 'history'] as const).map((value) => ({
    value,
    label: t(`leave.segments.${value}`),
    count: counts[value] ?? 0,
  }))

  let rows = listed
  if (segmentParam === 'pending' || segmentParam === 'upcoming' || segmentParam === 'history') {
    rows = listed.filter((row) => segmentOf(row, today) === segmentParam)
  } else if (segmentParam === 'today') {
    rows = listed.filter((row) => row.status === 'approved' && onLeaveEmploymentIds.has(row.employmentId))
  }

  const { workerByEmployment } = await loadQueueLabels(
    orgId,
    [...new Set(rows.map((row) => row.employmentId))],
    [],
  )
  const queueRows: LeaveQueueRow[] = rows.map((row) => {
    const worker = workerByEmployment.get(row.employmentId)
    const name = worker?.name ?? null
    const party = worker?.partyId ?? null
    return {
      ...row,
      employeeName: name,
      partyId: party,
      employeeLabel: name ?? t('queue.notAvailable'),
      employeeHref: party ? `/entities/employees?party=${encodeURIComponent(party)}` : null,
      statusLabel: leaveStatusLabel(t, row.status),
      statusVariant: leaveStatusVariant(row.status),
      requestHref: leaveHref('/hrm/leave', sp.segment, { request: row.id }),
      openLabel: t('leave.openRequest'),
      rangeLabel: `${row.startsOn} → ${row.endsOn}`,
    }
  })

  const departments = (await db.execute<{ id: string; name: string }>(sql`
    select id::text as id, name from departments where org_id = ${orgId}::uuid and is_active order by name
  `)).rows

  // Department calendar: absence days in the window, grouped by date. The
  // engine scopes every member row; an empty window reads empty, never all.
  let calendarDays: LeaveQueueData['calendarDays'] = []
  const departmentId = sp.department ?? ''
  const from = sp.from ?? today
  const to = sp.to ?? today
  if (departmentId) {
    try {
      const days = await absenceCalendarForDepartment(db, orgId, authz.user.id, departmentId, from, to)
      const byDate = new Map<string, { workerName: string; hours: string; leaveTypeCode: string }[]>()
      for (const day of days) {
        const entries = byDate.get(day.onDate) ?? []
        entries.push({ workerName: day.workerName, hours: day.hours, leaveTypeCode: day.leaveTypeCode })
        byDate.set(day.onDate, entries)
      }
      calendarDays = [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, entries]) => ({ date, entries }))
    } catch {
      calendarDays = []
    }
  }

  return {
    ...base,
    refusal: null,
    hasContent: true,
    counts,
    total: listed.length,
    truncated,
    segments,
    rows: queueRows,
    departmentOptions: departments.map((row) => ({ value: row.id, label: row.name })),
    calendarDays,
  }
}

export interface MyLeaveBalance {
  leaveTypeCode: string
  kind: 'time' | 'value'
  balance: string | null
  unlimited: boolean
}

export interface MyLeaveData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  refusal: LeaveRefusal | null
  hasContent: boolean
  requests: LeaveQueueRow[]
  balancesTitle: string
  balances: MyLeaveBalance[]
  balancesEmpty: string
  timeKindLabel: string
  valueKindLabel: string
  unlimitedLabel: string
  columns: { employee: string; type: string; range: string; hours: string; status: string }
  emptyTitle: string
  emptyDescription: string
  fileButton: string
  fileTitle: string
  queue: { notAvailable: string; openEmployee: string }
  openRequest: string
  fileHref: string
  dialogOpen: boolean
  dialogRequestId: string | null
  dialogCloseHref: string
}

/** Self-service inbox: the caller's own requests and balances, nothing else. */
export async function loadMyLeave(
  authz: Authz,
  sp: Record<string, string | undefined> = {},
): Promise<MyLeaveData> {
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')
  const base = {
    title: t('myLeave.title'),
    description: t('myLeave.description'),
    tabs: await hrmGroupTabs(authz, '/hrm/my-leave'),
    columns: {
      employee: t('leave.columns.employee'),
      type: t('leave.columns.type'),
      range: t('leave.columns.range'),
      hours: t('leave.columns.hours'),
      status: t('leave.columns.status'),
    },
    emptyTitle: t('myLeave.emptyTitle'),
    emptyDescription: t('myLeave.emptyDescription'),
    fileButton: t('leave.fileButton'),
    fileTitle: t('leave.fileTitle'),
    balancesTitle: t('myLeave.balancesTitle'),
    balancesEmpty: t('myLeave.balancesEmpty'),
    timeKindLabel: t('myLeave.timeKind'),
    valueKindLabel: t('myLeave.valueKind'),
    unlimitedLabel: t('myLeave.unlimited'),
    queue: { notAvailable: t('queue.notAvailable'), openEmployee: t('queue.openEmployee') },
    openRequest: t('leave.openRequest'),
    fileHref: leaveHref('/hrm/my-leave', undefined, { file: '1' }),
    dialogOpen: sp.file !== undefined || (typeof sp.request === 'string' && sp.request !== ''),
    dialogRequestId: typeof sp.request === 'string' && sp.request !== '' ? sp.request : null,
    dialogCloseHref: '/hrm/my-leave',
  }
  let inbox: LeaveRequestSummary[]
  try {
    inbox = await myLeaveRequests({ orgId, actorId: authz.user.id })
  } catch (error) {
    const message = error instanceof HrmAuthorizationError || error instanceof LeaveError ? error.message : null
    return { ...base, refusal: message ? { title: t('leave.refusedTitle'), message } : null, hasContent: message === null, requests: [], balances: [] }
  }
  const { workerByEmployment } = await loadQueueLabels(
    orgId,
    [...new Set(inbox.map((row) => row.employmentId))],
    [],
  )
  const requests: LeaveQueueRow[] = inbox.map((row) => {
    const worker = workerByEmployment.get(row.employmentId)
    const name = worker?.name ?? null
    const party = worker?.partyId ?? null
    return {
      ...row,
      employeeName: name,
      partyId: party,
      employeeLabel: name ?? t('queue.notAvailable'),
      employeeHref: party ? `/entities/employees?party=${encodeURIComponent(party)}` : null,
      statusLabel: leaveStatusLabel(t, row.status),
      statusVariant: leaveStatusVariant(row.status),
      requestHref: leaveHref('/hrm/my-leave', undefined, { request: row.id }),
      openLabel: t('leave.openRequest'),
      rangeLabel: `${row.startsOn} → ${row.endsOn}`,
    }
  })
  const asOf = await businessToday(orgId)
  const balances: MyLeaveBalance[] = []
  const own = await loadOwnEmploymentIds(db, orgId, authz.user.id)
  const employmentId = own[0]
  if (employmentId) {
    const types = await listLeaveTypes(db, orgId)
    for (const type of types) {
      if (!type.isActive) continue
      const read = await timeBalanceAsOf(db, orgId, employmentId, type.id, asOf)
      balances.push({ leaveTypeCode: type.code, kind: 'time', balance: read.balance, unlimited: read.unlimited })
    }
    // VALUE beside TIME, each labelled: the worker's payroll banks as of today.
    const partyRows = (await db.execute<{ party: string }>(sql`
      select worker_party_id::text as party from worker_employments
       where org_id = ${orgId}::uuid and id = ${employmentId}::uuid
    `)).rows
    const party = partyRows[0]?.party
    if (party) {
      const banks = await payrollBankBalances(orgId, party, { asOf })
      for (const bank of banks) {
        balances.push({ leaveTypeCode: bank.planCode, kind: 'value', balance: bank.balance, unlimited: false })
      }
    }
  }
  return { ...base, refusal: null, hasContent: true, requests, balances }
}

export interface LeavePanelData {
  title: string
  onLeaveToday: { workerName: string; leaveTypeCode: string; hours: string }[]
  onLeaveEmpty: string
  pendingCount: number
  pendingLabel: string
  queueHref: string
}

/** HR overview Leave panel: on leave today plus pending approvals. */
export async function loadLeavePanel(authz: Authz): Promise<LeavePanelData | null> {
  if (!can(authz, 'hrm.leave.read')) return null
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')
  const today = await businessToday(orgId)
  const onLeave = await employmentsOnLeave(db, orgId, today)
  const pending = await listOrgLeaveRequests(db, orgId, authz.user.id, { status: 'submitted', limit: 6 })
  return {
    title: t('overview.leave.title'),
    onLeaveToday: onLeave.slice(0, 5).map((entry) => ({
      workerName: entry.workerName,
      leaveTypeCode: entry.leaveTypeCode,
      hours: entry.hours,
    })),
    onLeaveEmpty: t('overview.leave.onLeaveEmpty'),
    pendingCount: pending.requests.length,
    pendingLabel: t('overview.leave.pendingSub'),
    queueHref: '/hrm/leave?segment=pending',
  }
}
