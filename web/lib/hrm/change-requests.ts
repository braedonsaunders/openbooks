import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  HrmChangeRequestError,
  listChangeRequests,
} from '@openbooks/engine/src/hrm/change-requests.ts'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import { can, type Authz } from '../authz'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { resolveQueueStatus, segmentOfServiceStatus, QUEUE_SEGMENTS } from './queue-status'

/**
 * Org-wide employment change-request queue — one read for the working
 * surface behind the Change requests tab.
 *
 * The LIST comes from the existing service (listChangeRequests: newest
 * first, per-row employment read gate, subsidiary scope inside), never a
 * direct request-table read from the web app. Two display-resolution
 * queries ride beside it — employment→worker names and user→requester
 * names — keyed strictly by ids the service already authorized, with the
 * org predicate on every leg. They resolve labels only; status filtering,
 * ordering, and scope stay the service's.
 *
 * Computed refusals travel as data (an unknown `status` param, a
 * subsidiary-scope denial mid-list): the page renders them as refusals
 * beside the segments, never an empty table pretending to be data.
 */

/** Bounded page: the service refuses limits outside 1..500. */
const QUEUE_LIMIT = 500

export interface QueueRow {
  id: string
  employmentId: string
  employeeName: string | null
  partyId: string | null
  kind: string
  effectiveFrom: string | null
  effectiveTo: string | null
  status: string
  requesterName: string | null
  submittedAt: string | null
  createdAt: string
}

export interface QueueSegment {
  value: string
  label: string
  count: number
}

export interface QueueRefusal {
  title: string
  message: string
}

export interface ChangeRequestQueueData {
  title: string
  description: string
  listTitle: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  refusal: QueueRefusal | null
  hasContent: boolean
  segmentsLabel: string
  allLabel: string
  counts: Record<string, number>
  total: number
  truncated: boolean
  truncatedNote: string
  segments: QueueSegment[]
  currentParams: Record<string, string | string[] | undefined>
  columns: {
    employee: string
    kind: string
    effective: string
    requester: string
    submitted: string
  }
  rows: QueueRow[]
  emptyTitle: string
  emptyDescription: string
  canManage: boolean
  departmentOptions: { value: string; label: string }[]
  proposeTitle: string
  proposeButton: string
  proposeEmploymentLabel: string
  proposeEmploymentPlaceholder: string
  proposeEmpty: string
  proposeFailed: string
  queue: {
    draftBadge: string
    openEmployee: string
    notAvailable: string
  }
}

type ServiceRow = Awaited<ReturnType<typeof listChangeRequests>>[number]

export interface QueueLabels {
  workerByEmployment: Map<string, { name: string | null; partyId: string | null }>
  requesterByUser: Map<string, string>
}

/**
 * Display labels for queue-shaped rows, shared by the queue page and the
 * overview cockpit so the two cannot resolve names differently. Keyed
 * strictly by ids the change-request service already authorized, with the
 * org predicate on every leg. Bare JS arrays are never interpolated into
 * ANY() (they bind as row constructors); each id is its own parameter.
 */
export async function loadQueueLabels(
  orgId: string,
  employmentIds: readonly string[],
  userIds: readonly string[],
): Promise<QueueLabels> {
  const workerByEmployment = new Map<string, { name: string | null; partyId: string | null }>()
  if (employmentIds.length > 0) {
    const ids = employmentIds.map((id) => sql`${id}::uuid`)
    const rows = (await db.execute<{ employmentId: string; workerName: string | null; partyId: string | null }>(sql`
      select w.id::text as "employmentId", p.display_name as "workerName", p.id::text as "partyId"
        from worker_employments w
        join parties p on p.id = w.worker_party_id and p.org_id = w.org_id
       where w.org_id = ${orgId}::uuid and w.id in (${sql.join(ids, sql`, `)})`)).rows
    for (const row of rows) workerByEmployment.set(row.employmentId, { name: row.workerName, partyId: row.partyId })
  }
  const requesterByUser = new Map<string, string>()
  if (userIds.length > 0) {
    const ids = userIds.map((id) => sql`${id}::uuid`)
    const rows = (await db.execute<{ userId: string; workerName: string | null; userName: string }>(sql`
      select u.id::text as "userId", p.display_name as "workerName", u.name as "userName"
        from users u
        left join parties p on p.id = u.party_id and p.org_id = u.org_id
       where u.org_id = ${orgId}::uuid and u.id in (${sql.join(ids, sql`, `)})`)).rows
    for (const row of rows) requesterByUser.set(row.userId, row.workerName ?? row.userName)
  }
  return { workerByEmployment, requesterByUser }
}

function effectiveWindow(payload: { kind: string } & Record<string, unknown>): {
  from: string | null
  to: string | null
} {
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
  if (payload.kind === 'termination') {
    return { from: text(payload.effectiveDate), to: null }
  }
  return { from: text(payload.effectiveFrom), to: text(payload.effectiveTo) }
}

export async function loadChangeRequestQueue(
  authz: Authz,
  sp: Record<string, string | string[] | undefined>,
): Promise<ChangeRequestQueueData> {
  // The caller (the queue view) owns the page gate — requirePermission plus
  // the hrm switch with a 404. This loader never re-checks either; it
  // resolves the queue for the authorized session it is given.
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')

  const base: Omit<ChangeRequestQueueData, 'refusal' | 'hasContent' | 'rows' | 'counts' | 'total' | 'truncated' | 'segments'> = {
    title: t('queue.title'),
    description: t('queue.description'),
    listTitle: t('queue.listTitle'),
    tabs: await hrmGroupTabs(authz, '/hrm/change-requests'),
    segmentsLabel: t('queue.segmentsLabel'),
    allLabel: t('queue.allLabel'),
    truncatedNote: t('queue.truncatedNote', { limit: QUEUE_LIMIT }),
    currentParams: { ...(typeof sp.status === 'string' ? { status: sp.status } : {}) },
    columns: {
      employee: t('queue.columns.employee'),
      kind: t('queue.columns.kind'),
      effective: t('queue.columns.effective'),
      requester: t('queue.columns.requester'),
      submitted: t('queue.columns.submitted'),
    },
    emptyTitle: t('queue.emptyTitle'),
    emptyDescription: t('queue.emptyDescription'),
    canManage: can(authz, 'hrm.employment.manage'),
    departmentOptions: [],
    proposeTitle: t('queue.proposeTitle'),
    proposeButton: t('queue.proposeButton'),
    proposeEmploymentLabel: t('queue.proposeEmploymentLabel'),
    proposeEmploymentPlaceholder: t('queue.proposeEmploymentPlaceholder'),
    proposeEmpty: t('queue.proposeEmpty'),
    proposeFailed: t('queue.proposeFailed'),
    queue: {
      draftBadge: t('queue.draftBadge'),
      openEmployee: t('queue.openEmployee'),
      notAvailable: t('queue.notAvailable'),
    },
  }

  const refuse = (title: string, message: string): ChangeRequestQueueData => ({
    ...base,
    refusal: { title, message },
    hasContent: false,
    rows: [],
    counts: {},
    total: 0,
    truncated: false,
    segments: [],
  })

  const rawStatus = typeof sp.status === 'string' ? sp.status : undefined
  const resolved = resolveQueueStatus(rawStatus ?? null)
  if (!resolved.ok) {
    return refuse(t('queue.refusalTitle'), t('queue.unknownSegment', { value: rawStatus ?? '' }))
  }

  let serviceRows: ServiceRow[]
  try {
    // One bounded read for both the counts and the list, so the segments
    // and the rows can never disagree about what was fetched.
    serviceRows = await listChangeRequests({ orgId, actorId: authz.user.id, limit: QUEUE_LIMIT })
  } catch (error) {
    // The service enforces subsidiary scope per row by refusing: a mixed-
    // scope actor sees the refusal with its remedy, never a partial list
    // pretending to be the whole queue.
    if (error instanceof HrmAuthorizationError || error instanceof HrmChangeRequestError) {
      return refuse(t('queue.refusalTitle'), (error as Error).message)
    }
    throw error
  }

  const counts: Record<string, number> = {}
  for (const segment of QUEUE_SEGMENTS) counts[segment] = 0
  for (const row of serviceRows) {
    const segment = segmentOfServiceStatus(row.status)
    if (segment !== null) counts[segment] = (counts[segment] ?? 0) + 1
  }
  const segmentLabel = (segment: string): string =>
    t.has(`queue.segments.${segment}`) ? t(`queue.segments.${segment}`) : segment
  const segments: QueueSegment[] = QUEUE_SEGMENTS.map((segment) => ({
    value: segment,
    label: `${segmentLabel(segment)} (${counts[segment] ?? 0})`,
    count: counts[segment] ?? 0,
  }))

  const visible = resolved.serviceStatus === null
    ? serviceRows
    : serviceRows.filter((row) => row.status === resolved.serviceStatus)

  // Display labels only, through the shared resolver the overview
  // cockpit reuses so the two surfaces cannot resolve names differently.
  const employmentIds = [...new Set(visible.map((row) => row.employmentId))]
  const userIds = [...new Set(visible.flatMap((row) => [row.submittedBy, row.createdBy]).filter((id): id is string => id !== null))]
  const { workerByEmployment, requesterByUser } = await loadQueueLabels(orgId, employmentIds, userIds)
  // Departments feed the propose/edit drawer, exactly like the employee
  // drawer's own picker: active names, org-scoped, never ids alone.
  const departments = (await db.execute<{ id: string; name: string }>(sql`
    select id::text as id, name from departments where org_id = ${orgId}::uuid and is_active order by name`)).rows

  const rows: QueueRow[] = visible.map((row) => {
    const window = effectiveWindow(row.payload as { kind: string } & Record<string, unknown>)
    const worker = workerByEmployment.get(row.employmentId)
    const requesterId = row.submittedBy ?? row.createdBy
    return {
      id: row.id,
      employmentId: row.employmentId,
      employeeName: worker?.name ?? null,
      partyId: worker?.partyId ?? null,
      kind: (row.payload as { kind: string }).kind,
      effectiveFrom: window.from,
      effectiveTo: window.to,
      status: row.status,
      requesterName: requesterId !== null ? (requesterByUser.get(requesterId) ?? null) : null,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }
  })

  return {
    ...base,
    refusal: null,
    hasContent: true,
    rows,
    counts,
    total: serviceRows.length,
    truncated: serviceRows.length >= QUEUE_LIMIT,
    segments,
    departmentOptions: departments.map((row) => ({ value: row.id, label: row.name })),
  }
}
