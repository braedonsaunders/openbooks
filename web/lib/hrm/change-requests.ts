import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
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
  /** Display-resolved cells for the shared table block: labels, never ids. */
  employeeLabel: string
  employeeHref: string | null
  kindLabel: string
  effectiveWindow: string
  requesterLabel: string
  submittedLabel: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
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
  statusHeader: string
  actionsHeader: string
  proposeButton: string
  proposeHref: string
  proposeOpen: boolean
  dialogCloseHref: string
  proposeEmploymentLabel: string
  proposeEmploymentPlaceholder: string
  proposeEmpty: string
  proposeFailed: string
  queue: {
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

type Catalog = {
  (key: string, params?: Record<string, string | number>): string
  has: (key: string) => boolean
}

/** Header/dialog hrefs preserve the active status segment; the dialog closes by navigating the param away. */
function queueHref(status: string | undefined, propose: boolean): string {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (propose) params.set('propose', '1')
  const query = params.toString()
  return query ? `/hrm/change-requests?${query}` : '/hrm/change-requests'
}

/** The same kind labels the hand-rolled queue rendered, resolved where the rows come from. */
function kindLabelOf(t: Catalog, kind: string): string {
  const key =
    kind === 'hire'
      ? 'kindHire'
      : kind === 'status_change'
        ? 'kindStatusChange'
        : kind === 'assignment_change'
          ? 'kindAssignmentChange'
          : kind === 'termination'
            ? 'kindTermination'
            : null
  return key !== null ? t(`employment.changeRequests.${key}`) : kind
}

function changeRequestStatusVariant(status: string): QueueRow['statusVariant'] {
  if (status === 'draft') return 'secondary'
  if (status === 'pending_approval') return 'warning'
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'destructive'
  if (status === 'withdrawn') return 'outline'
  return 'default'
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
    statusHeader: t('employment.changeRequests.statusLabel'),
    actionsHeader: t('queue.draftBadge'),
    proposeButton: t('queue.proposeButton'),
    proposeHref: queueHref(typeof sp.status === 'string' ? sp.status : undefined, true),
    proposeOpen: sp.propose === '1',
    dialogCloseHref: queueHref(typeof sp.status === 'string' ? sp.status : undefined, false),
    proposeEmploymentLabel: t('queue.proposeEmploymentLabel'),
    proposeEmploymentPlaceholder: t('queue.proposeEmploymentPlaceholder'),
    proposeEmpty: t('queue.proposeEmpty'),
    proposeFailed: t('queue.proposeFailed'),
    queue: {
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
    const kind = (row.payload as { kind: string }).kind
    const status = row.status
    return {
      id: row.id,
      employmentId: row.employmentId,
      employeeName: worker?.name ?? null,
      partyId: worker?.partyId ?? null,
      kind,
      effectiveFrom: window.from,
      effectiveTo: window.to,
      status,
      requesterName: requesterId !== null ? (requesterByUser.get(requesterId) ?? null) : null,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      employeeLabel: worker?.name ?? t('queue.notAvailable'),
      employeeHref: worker?.partyId ? `/entities/employees?party=${encodeURIComponent(worker.partyId)}` : null,
      kindLabel: kindLabelOf(t, kind),
      effectiveWindow:
        window.from === null
          ? t('queue.notAvailable')
          : `${window.from} → ${window.to ?? t('employment.episodes.present')}`,
      requesterLabel:
        requesterId !== null ? (requesterByUser.get(requesterId) ?? t('queue.notAvailable')) : t('queue.notAvailable'),
      submittedLabel: row.submittedAt ? row.submittedAt.toISOString() : t('queue.notAvailable'),
      statusLabel: t.has(`employment.changeRequests.statusNames.${status}`)
        ? t(`employment.changeRequests.statusNames.${status}`)
        : status,
      statusVariant: changeRequestStatusVariant(status),
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
