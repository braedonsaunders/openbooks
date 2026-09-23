import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { inArray, sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db, schema } from '@openbooks/engine/src/platform/db.ts'
import { type WorklistGate } from '@openbooks/engine/src/flows/index.ts'
import { listInbox, type InboxItem } from '@openbooks/engine/src/inbox/index.ts'
import {
  approvalWorklistPageForAuthz,
  type ApprovalWorklistItem,
} from '../../../lib/application/approvals'
import { inboxContext, INBOX_FILTER_KINDS, INBOX_TASK_KINDS, maySeeUnion } from '../../../lib/inbox-context'
import {
  badge,
  column,
  field,
  frame,
  grid,
  money,
  page,
  pageHeader,
  ref,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getAuthz, can } from '../../../lib/authz'
import { APPROVALS_BULK_BATCH_MAX } from '../../../lib/approvals-limits'
import { clamp, pickString } from '../../../lib/list-params'
import { approvalRecordHref } from '../../../lib/approvals-links'
import { resolveApprovalSubjects } from '../../../lib/approval-subjects'
import { pgTextArrayLiteral } from '../../../lib/pg-array'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import type { ApprovalRow } from './ApprovalsTable'
import type { DelegateOption } from './GateActions'

/**
 * The approval hub, split into a loader and a spec.
 *
 * FOUR searchParam-driven tabs, on the shared subtab strip (`module-home-tabs`
 * — the same component the Purchasing route strip uses, and the only one in
 * the product):
 *
 *   • mine      — approvals I can act on (direct, role, delegated-to-me),
 *                 with counts-by-kind chips, aging, and bulk approve/reject.
 *   • tasks     — my tasks: the non-decision inbox kinds (signatures,
 *                 notices, acknowledgements) with their generic actions.
 *   • submitted — where MY documents are: who they're pending with, since when.
 *   • all       — org-wide pending items (flows.manage / admin only).
 *
 * `tasks` IS A TAB and not a panel. It used to render as a titled panel
 * stacked under the approvals table, so one page showed two unrelated
 * worklists down the screen with no way to see either on its own. A second
 * list under the first is a tab; it is never a second section.
 *
 * `all` is gated on `flows.manage` in the LOADER, before the query runs — an
 * unauthorized `?tab=all` falls back to `mine` rather than rendering an empty
 * org-wide list, which would still leak that the tab exists.
 *
 * The body is wrapped in `TabContent`, which is a component rather than a div,
 * so this is the first page to use a `frame`: a named host wrapper with
 * spec-authored children.
 */

type Tab = 'mine' | 'tasks' | 'submitted' | 'all'

/**
 * Task-list filters. `approvals` is gone as a filter: the union table is now
 * reached by the tab, so a filter that meant "hide the tasks below the table"
 * has nothing left to hide.
 */
type InboxFilter = 'all' | 'my_tasks' | 'signatures' | 'notices' | 'overdue'

const INBOX_FILTERS: readonly InboxFilter[] = [
  'all',
  'my_tasks',
  'signatures',
  'notices',
  'overdue',
]

// Document kinds with catalog labels — unknown kinds fall back to the raw code.
const KIND_KEYS = [
  'vendor_bill',
  'customer_invoice',
  'expense_report',
  'journal',
  'purchase_order',
  'sales_order',
  'quote',
  'close_run',
  'budget_scenario',
  'hrm_employment_change_request',
]

export interface SubmittedListRow {
  key: string
  documentNumber: string
  kind: string
  href: string | null
  party: string | null
  amount: string | null
  engineName: string
  pendingWith: string | null
  waitingSince: string
  waitingSinceDate: string
  kindLabel: string
  statusLabel: string
}

function iso(d: unknown): string {
  return d ? new Date(d as string | Date).toISOString() : new Date().toISOString()
}

export interface InboxTaskListRow {
  id: string
  kindLabel: string
  title: string
  subtitle: string | null
  dueLabel: string | null
  priorityLabel: string | null
  priorityTone: 'rose' | 'amber' | 'slate'
  href: string
  actions: { key: string; label: string; style: 'primary' | 'secondary' | 'danger'; needsReason: boolean }[]
}

export interface ApprovalsData {
  title: string
  description: string
  delegateUsers: DelegateOption[]
  tabs: { key: string; href: string; label: string; active: boolean; count: number | null }[]
  onSubmitted: boolean
  submittedEmpty: boolean
  submittedPresent: boolean
  gatesEmpty: boolean
  gatesPresent: boolean
  emptySubmittedTitle: string
  emptySubmittedDescription: string
  emptyTitle: string
  emptyDescription: string
  currentParams: Record<string, string | string[] | undefined>
  searchPlaceholder: string
  toolbarFilters: {
    paramKey: string
    label: string
    allLabel: string
    options: { value: string; label: string; count?: number }[]
  }[]
  columnDocument: string
  columnKind: string
  columnParty: string
  columnAmount: string
  columnApproval: string
  columnPendingWith: string
  columnWaitingSince: string
  columnStatus: string
  submittedRows: SubmittedListRow[]
  approvalRows: ApprovalRow[]
  bulk: boolean
  showAssignee: boolean
  actionsEnabled: boolean
  tabKey: string
  /** Filtered total across all union legs (drives pagination). */
  total: number
  /** Unfiltered total (drives the mine count bubble and the empty state). */
  unfilteredTotal: number
  page: number
  perPage: number
  /** Plain-string search params for pagination links. */
  paginationParams: Record<string, string>
  /** Submitted tab: flow runs + own budgets combined total. */
  submittedTotal: number
  /** Unified inbox filter selected through the shared toolbar dropdown. */
  filter: InboxFilter
  /** Union table visibility: decision rows show for all/approvals/overdue. */
  showUnion: boolean
  /** Task list (new kinds + notices) for the active filter. */
  showTasks: boolean
  tasksPresent: boolean
  tasksEmpty: boolean
  taskRows: InboxTaskListRow[]
  tasksEmptyTitle: string
  tasksEmptyDescription: string
  taskOpenLabel: string
  taskActedLabel: string
  taskDelegatePlaceholder: string
}

export async function loadApprovals(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApprovalsData | null> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('approvals')
  const tc = await getTranslations('common')
  const ti = await getTranslations('inbox')
  const th = await getTranslations('hrm')
  const authz = await getAuthz()
  if (!authz) return null
  const user = authz.user
  const orgId = user.orgId
  const canManageFlows = can(authz, 'flows.manage')
  const canSeeAll = canManageFlows

  const rawTab = pickString(sp.tab)
  const tab: Tab =
    rawTab === 'submitted'
      ? 'submitted'
      : rawTab === 'tasks'
        ? 'tasks'
        : rawTab === 'all' && canSeeAll
          ? 'all'
          : 'mine'
  /** The two tabs the approvals union backs. */
  const onApprovals = tab === 'mine' || tab === 'all'
  const kindFilter = pickString(sp.kind) || undefined
  const query = pickString(sp.q)?.trim() || undefined
  const rawFilter = pickString(sp.filter)
  const filter: InboxFilter = (INBOX_FILTERS as readonly string[]).includes(rawFilter ?? '')
    ? (rawFilter as InboxFilter)
    : 'all'
  const overdueOnly = onApprovals && filter === 'overdue'

  // Server-side window shared by every tab on this page. perPage never
  // exceeds the bulk batch ceiling, so a page-scoped selection always fits
  // a single bulk request (pinned by approvals-paging.test.ts).
  const page = clamp(Number(pickString(sp.page) ?? '1'), 1, 10_000)
  const perPage = Math.min(
    clamp(Number(pickString(sp.perPage) ?? '25'), 5, 100),
    APPROVALS_BULK_BATCH_MAX,
  )
  const offset = (page - 1) * perPage
  const prefix = offset + perPage
  const paginationParams: Record<string, string> = {}
  for (const [key, value] of Object.entries(sp)) {
    const single = pickString(value)
    if (single != null) paginationParams[key] = single
  }

  const kindLabel = (kind: string) =>
    KIND_KEYS.includes(kind) ? t(`kinds.${kind}`) : kind.replace(/_/g, ' ')

  // ---- My + All approvals: the unified worklist (F-t01-007) -----------------
  // The dashboard tile counts approvalWorklistForAuthz (Flows gates +
  // gateless document approvals + pending pay runs); the center reads the
  // same reader so same-labeled figures tie by construction. Same doorway
  // as the tile and get_vitals: a caller who cannot approve anything sees
  // no rows rather than a forbidden error. Same doorway as the count route.
  const mayApprove = maySeeUnion(authz)
  // One server-side page over the union: each leg fetches its leading
  // offset+limit rows in SQL and the total/chips come from aggregates, so no
  // request ever scans a whole leg. Same reader family as the dashboard tile
  // (approvalWorklistForAuthz), same doorway, same per-item shape.
  const unionPage = mayApprove
    ? await approvalWorklistPageForAuthz(authz, {
        limit: perPage,
        offset,
        kind: kindFilter,
        query,
        overdue: overdueOnly,
      })
    : { items: [] as ApprovalWorklistItem[], total: 0, kindCounts: new Map<string, number>() }
  const unified: ApprovalWorklistItem[] = unionPage.items
  const unionTotal = unionPage.total
  // Chips ignore the kind filter, so their counts sum to the unfiltered
  // total (drives the mine bubble and the empty state).
  let unfilteredTotal = 0
  for (const count of unionPage.kindCounts.values()) unfilteredTotal += count

  // Flow names for the gate rows (WorklistGate carries only flowId).
  const flowIds = [
    ...new Set(unified.flatMap((i) => (i.kind === 'flow_gate' ? [i.flowId] : []))),
  ]
  const flowNames = new Map<string, string>()
  if (flowIds.length > 0) {
    const rows = await db
      .select({ id: schema.flows.id, name: schema.flows.name })
      .from(schema.flows)
      .where(inArray(schema.flows.id, flowIds))
    for (const r of rows) flowNames.set(r.id, r.name)
  }

  // Display names for gate assignees (the union carries ids/roles only).
  const assigneeIds = [
    ...new Set(
      unified.flatMap((i) =>
        i.kind === 'flow_gate' && i.assigneeUserId != null ? [i.assigneeUserId] : [],
      ),
    ),
  ]
  const assigneeNames = new Map<string, string>()
  if (assigneeIds.length > 0) {
    const rows = await db.execute<Record<string, unknown>>(sql`
      select id, name from users where org_id = ${orgId} and id = any(${pgTextArrayLiteral(assigneeIds)}::uuid[])
    `)
    for (const r of rows.rows) assigneeNames.set(String(r.id), String(r.name))
  }

  const gateToRow = (g: WorklistGate, assignee: string | null): ApprovalRow => {
    const kind = g.document?.kind ?? g.subjectKind
    // Subject-kind detail (the employee and the decision summary for
    // change requests): resolved in one batch below through the
    // per-kind registry — never inline special cases here.
    const subject = subjectDetails.get(`${g.subjectKind}:${g.subjectId}`)
    return {
      key: `gate:${g.id}`,
      gateId: g.id,
      overdue: g.escalateAt != null && new Date(g.escalateAt).getTime() < Date.now(),
      documentNumber: g.document?.documentNumber ?? subject?.summary ?? g.subjectLabel ?? g.subjectId.slice(0, 8),
      kind,
      kindLabel: kindLabel(kind),
      href: g.href ?? approvalRecordHref(kind, g.subjectId),
      party: g.document?.partyName ?? subject?.partyName ?? null,
      amount: g.document ? formatMoney(g.document.total) : null,
      approvalTitle: g.title,
      engineName: flowNames.get(g.flowId) ?? '',
      requestedAt: iso(g.createdAt),
      assignee,
      canDelegate: canManageFlows || g.assigneeUserId === user.id,
      quorumAll: g.quorum === 'all',
      signatureRequired: g.signatureRequired,
    }
  }

  // Document rows link to their record drawer, where the module surface
  // decides gateless approvals; pay-run rows link to the run. Only flow
  // gates carry bulk/delegate actions (GateActions stays gate-scoped).
  const docToRow = (d: Extract<ApprovalWorklistItem, { kind: 'document' }>): ApprovalRow => ({
    key: `doc:${d.id}`,
    gateId: null,
    documentNumber: d.documentNumber,
    kind: d.docKind,
    kindLabel: kindLabel(d.docKind),
    href: approvalRecordHref(d.docKind, d.id),
    party: d.partyName,
    amount: formatMoney(d.total),
    approvalTitle: null,
    engineName: '',
    requestedAt: iso(d.submittedAt ?? d.createdAt),
    assignee: null,
    canDelegate: false,
    quorumAll: false,
    signatureRequired: false,
  })

  // Budget rows link to the budget drawer, where the checker decision is
  // recorded; like documents they carry no gate actions (F-t13-005).
  const budgetToRow = (b: Extract<ApprovalWorklistItem, { kind: 'budget' }>): ApprovalRow => ({
    key: `budget:${b.id}`,
    gateId: null,
    documentNumber: b.name,
    kind: 'budget_scenario',
    kindLabel: kindLabel('budget_scenario'),
    href: approvalRecordHref('budget_scenario', b.id),
    party: null,
    amount: formatMoney(b.total),
    approvalTitle: null,
    engineName: '',
    requestedAt: iso(b.submittedAt ?? b.createdAt),
    assignee: null,
    canDelegate: false,
    quorumAll: false,
    signatureRequired: false,
  })

  const payToRow = (p: Extract<ApprovalWorklistItem, { kind: 'pay_run' }>): ApprovalRow => ({
    key: `payrun:${p.id}`,
    gateId: null,
    documentNumber: p.runNumber,
    kind: 'pay_run',
    kindLabel: kindLabel('pay_run'),
    href: approvalRecordHref('pay_run', p.id),
    party: null,
    amount: formatMoney(p.totalAmount),
    approvalTitle: p.purpose || null,
    engineName: '',
    requestedAt: iso(p.submittedAt ?? p.createdAt),
    assignee: null,
    canDelegate: false,
    quorumAll: false,
    signatureRequired: false,
  })

  // Subject-kind detail for flow gates (party + decision summary): one
  // batched, org-scoped read through the per-kind registry — unresolvable
  // subjects stay absent and their rows keep the id fallback.
  const subjectDetails = await resolveApprovalSubjects(
    orgId,
    unified.flatMap((item) =>
      item.kind === 'flow_gate' ? [{ kind: item.subjectKind, subjectId: item.subjectId }] : [],
    ),
    th,
  )

  const unionToRow = (item: ApprovalWorklistItem, assignee: string | null): ApprovalRow => {
    if (item.kind === 'document') return docToRow(item)
    if (item.kind === 'budget') return budgetToRow(item)
    if (item.kind === 'pay_run') return payToRow(item)
    return gateToRow(item, assignee)
  }

  // The engine returns the window in merge order; re-sorting the bounded
  // window is a safety net, not a second paging implementation.
  const byRequestedAt = (a: ApprovalRow, b: ApprovalRow) =>
    a.requestedAt.localeCompare(b.requestedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const mineRows: ApprovalRow[] = unified
    .map((item) => unionToRow(item, null))
    .sort(byRequestedAt)
  const mineCount = unfilteredTotal

  // ---- All approvals (same union reader as mine + tile) --------------------
  // The tab stays canSeeAll-gated, but its rows are the caller's actionable
  // union — identical to the tile count by construction.
  let allRows: ApprovalRow[] = []
  if (tab === 'all' && canSeeAll) {
    const assigneeOf = (item: ApprovalWorklistItem): string | null => {
      if (item.kind !== 'flow_gate') return null
      if (item.assigneeUserId != null) {
        return assigneeNames.get(item.assigneeUserId) ?? item.assigneeRole ?? null
      }
      return item.assigneeRole ?? null
    }
    allRows = unified
      .map((item) => unionToRow(item, assigneeOf(item)))
      .sort(byRequestedAt)
  }

  // ---- Submitted by me ------------------------------------------------------
  // Same window as the union tabs: the flow leg pages in SQL (window total
  // via over()), the caller's own budgets ride along capped (their scope is
  // one user, same precedent as the delegate picker), and the loader merges
  // and slices the bounded inputs.
  let submittedRows: SubmittedListRow[] = []
  let submittedTotal = 0
  if (tab === 'submitted') {
    const flowRes = await db.execute<Record<string, unknown>>(sql`
      select r.id as "runId", f.name as "flowName", r.subject_id as "subjectId",
             coalesce(d.document_number, cp.name) as "documentNumber",
             coalesce(d.kind, case when cr.id is not null then 'close_run' end, r.subject_kind) as kind,
             d.total, d.subsidiary_id as "subsidiaryId", coalesce(d.status, cr.status) as "docStatus", p.display_name as "partyName",
             min(g.created_at) as "waitingSince",
             string_agg(distinct coalesce(u.name, g.assignee_role), ', ') as "pendingWith",
             count(*) over () as "fullCount"
        from flow_runs r
        join flows f on f.id = r.flow_id and f.org_id = r.org_id
        join flow_gates g on g.run_id = r.id and g.org_id = r.org_id and g.status = 'pending'
        left join documents d on d.id = r.subject_id and d.org_id = r.org_id
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        left join close_runs cr on cr.id = r.subject_id and cr.org_id = r.org_id and r.subject_kind = 'close_run'
        left join accounting_periods cp on cp.id = cr.period_id and cp.org_id = cr.org_id
        left join users u on u.id = g.assignee_user_id
       where r.org_id = ${orgId} and r.status = 'waiting'
         and coalesce(d.created_by, cr.started_by) = ${user.id}
         ${kindFilter ? sql`and coalesce(d.kind, case when cr.id is not null then 'close_run' end, r.subject_kind) = ${kindFilter}` : sql``}
         ${query ? sql`and position(${query.toLowerCase()} in lower(concat_ws(' ',
           d.document_number, d.kind, r.subject_kind, f.name, p.display_name, cp.name))) > 0` : sql``}
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
       group by r.id, f.name, r.subject_id, d.document_number, d.kind, d.total,
                d.subsidiary_id, d.status, cr.id, cr.status, cp.name, p.display_name
       order by min(g.created_at), r.id
       limit ${prefix}
    `)
    submittedTotal = Number(flowRes.rows[0]?.fullCount ?? 0)

    submittedRows = flowRes.rows
      .map((r): SubmittedListRow => {
        const kind = String(r.kind)
        const waitingSince = iso(r.waitingSince)
        return {
          key: `run:${r.runId}`,
          documentNumber: String(r.documentNumber),
          kind,
          kindLabel: kindLabel(kind),
          href: approvalRecordHref(kind, String(r.subjectId)),
          party: (r.partyName as string | null) ?? null,
          amount: r.total != null ? formatMoney(r.total as string) : null,
          engineName: String(r.flowName),
          pendingWith: (r.pendingWith as string | null) ?? null,
          waitingSince,
          waitingSinceDate: waitingSince.slice(0, 10),
          statusLabel: String(r.docStatus).replace(/_/g, ' '),
        }
      })

    // Budgets submitted through the direct maker/checker path create no flow
    // run, so the query above never sees them. List the caller's own pending
    // scenarios with the approvers who can decide them (F-t13-005). The flow
    // leg filters by kind in SQL; this small capped leg filters here.
    if (can(authz, 'budgets.read') && (!kindFilter || kindFilter === 'budget_scenario')) {
      const budgetRes = await db.execute<Record<string, unknown>>(sql`
        select bs.id as "budgetId", bs.name as "documentNumber",
               coalesce(sum(bl.amount), 0)::text as total,
               bs.status::text as "docStatus", bs.submitted_at as "waitingSince",
               (select string_agg(distinct u.name, ', ')
                  from users u
                  join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
                  join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id
                 where u.org_id = ${orgId} and u.is_active and u.id <> ${user.id}
                   and ar.permissions::jsonb ? 'budgets.approve') as "pendingWith"
          from budget_scenarios bs
          left join budget_lines bl on bl.scenario_id = bs.id and bl.org_id = bs.org_id
         where bs.org_id = ${orgId} and bs.status = 'pending_approval' and bs.submitted_by = ${user.id}
           ${query ? sql`and position(${query.toLowerCase()} in lower(concat_ws(' ', bs.name, bs.fiscal_year::text))) > 0` : sql``}
         group by bs.id
         order by bs.submitted_at, bs.id
         limit 500
      `)
      for (const r of budgetRes.rows) {
        const waitingSince = iso(r.waitingSince)
        submittedRows.push({
          key: `budget:${r.budgetId}`,
          documentNumber: String(r.documentNumber),
          kind: 'budget_scenario',
          kindLabel: kindLabel('budget_scenario'),
          href: approvalRecordHref('budget_scenario', String(r.budgetId)),
          party: null,
          amount: r.total != null ? formatMoney(r.total as string) : null,
          engineName: '',
          pendingWith: (r.pendingWith as string | null) ?? null,
          waitingSince,
          waitingSinceDate: waitingSince.slice(0, 10),
          statusLabel: String(r.docStatus).replace(/_/g, ' '),
        })
      }
    }
    // The budgets leg is one user's own submissions (capped above); the flow
    // leg carries the prefix. Merged and sliced like the union tabs.
    const budgetPushed = submittedRows.length - flowRes.rows.length
    submittedTotal = Number(flowRes.rows[0]?.fullCount ?? 0) + budgetPushed
    submittedRows.sort(
      (a, b) => a.waitingSince.localeCompare(b.waitingSince) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    submittedRows = submittedRows.slice(offset, offset + perPage)
  }

  // Delegate targets (row delegation + out-of-office picker).
  const usersRes = await db.execute<DelegateOption>(sql`
    select id, name from users
     where org_id = ${orgId} and is_active and id <> ${user.id}
     order by name limit 500
  `)
  const delegateUsers = usersRes.rows

  // ---- Kind filters (mine/all tabs) -----------------------------------------
  // Counts come from the union aggregates (unfiltered by kind, sorted by code
  // so dropdown order is stable across locales); the rows arrive kind-filtered
  // from SQL, so there is deliberately no second filter here.
  const rowsForTab = tab === 'all' ? allRows : mineRows
  const chipCounts = new Map<string, number>(
    [...unionPage.kindCounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  const visibleRows = rowsForTab
  const visibleSubmitted = submittedRows

  // ---- Task list (new inbox kinds + notices) ------------------------------
  // Union-owned kinds never render here (see INBOX_TASK_KINDS): decision
  // rows keep ApprovalsTable + GateActions, task rows get generic actions
  // through /api/inbox/act. One shared per-request cache backs the counts
  // and the active list so the sources read once.
  const ctx = await inboxContext(authz)
  const taskCache = new Map<string, InboxItem[]>()
  const taskKindsFor = (key: InboxFilter) =>
    key === 'all' || key === 'overdue' ? INBOX_TASK_KINDS : (INBOX_FILTER_KINDS[key] ?? [])
  const taskItemsFor = async (key: InboxFilter): Promise<InboxItem[]> => {
    const kinds = taskKindsFor(key)
    if (kinds.length === 0) return []
    const items = await listInbox(ctx, { kinds, cache: taskCache })
    return key === 'overdue' ? items.filter((item) => item.priority === 'overdue') : items
  }
  const [tasksAll, tasksMy, tasksSig, tasksNotices, tasksOverdue, tasksActive] = await Promise.all([
    taskItemsFor('all'),
    taskItemsFor('my_tasks'),
    taskItemsFor('signatures'),
    taskItemsFor('notices'),
    taskItemsFor('overdue'),
    taskItemsFor(filter),
  ])
  const toTaskRow = (item: InboxItem): InboxTaskListRow => ({
    id: item.id,
    kindLabel: ti(`kinds.${item.kind}`),
    title: item.title,
    subtitle: item.subtitle,
    dueLabel: item.dueAt ? item.dueAt.slice(0, 10) : null,
    priorityLabel:
      item.priority === 'overdue'
        ? ti('priorities.overdue')
        : item.priority === 'due_soon'
          ? ti('priorities.dueSoon')
          : null,
    priorityTone: item.priority === 'overdue' ? 'rose' : item.priority === 'due_soon' ? 'amber' : 'slate',
    href: item.subjectHref,
    actions: item.actions.map((action) => ({ ...action })),
  })
  // One worklist per tab. The union table and the task list no longer share
  // a page, so neither `showUnion` nor `showTasks` reads the filter any more:
  // the filter narrows the list the tab already chose.
  const showUnion = onApprovals
  const unionVisible = visibleRows
  const showTasks = tab === 'tasks'
  const taskRows = tasksActive
    .filter((item) => {
      if (!query) return true
      const haystack = [item.title, item.subtitle, item.kind].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(query.toLowerCase())
    })
    .map(toTaskRow)
  const tasksEmpty = showTasks && taskRows.length === 0
  const filterCount = (key: InboxFilter): number => {
    if (key === 'all') return tasksAll.length
    if (key === 'my_tasks') return tasksMy.length
    if (key === 'signatures') return tasksSig.length
    if (key === 'notices') return tasksNotices.length
    return tasksOverdue.length
  }

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'mine', label: t('tabs.mine'), count: mineCount },
    { key: 'tasks', label: ti('filters.myTasks'), count: tasksAll.length },
    { key: 'submitted', label: t('tabs.submitted') },
    ...(canSeeAll ? [{ key: 'all' as Tab, label: t('tabs.all') }] : []),
  ]

  // The approvals filters live in the regular shared list toolbar. They used
  // to be a second row of pills under the route tabs, giving the inbox two
  // competing tab treatments and no search control.
  const kindOptions = [...chipCounts.entries()].map(([kind, count]) => ({
    value: kind,
    label: kindLabel(kind),
    count,
  }))
  const submittedKindOptions = [...new Set([...KIND_KEYS, 'pay_run'])].map((kind) => ({
    value: kind,
    label: kindLabel(kind),
  }))
  const toolbarFilters = tab === 'tasks'
    ? [{
        paramKey: 'filter',
        label: ti('columns.task'),
        allLabel: tc('labels.all'),
        options: (['my_tasks', 'signatures', 'notices', 'overdue'] as const).map((key) => ({
          value: key,
          label: ti(`filters.${key === 'my_tasks' ? 'myTasks' : key}`),
          count: filterCount(key),
        })),
      }]
    : tab === 'submitted'
      ? [{
          paramKey: 'kind',
          label: t('table.kind'),
          allLabel: tc('labels.all'),
          options: submittedKindOptions,
        }]
      : [
          {
            paramKey: 'kind',
            label: t('table.kind'),
            allLabel: tc('labels.all'),
            options: kindOptions,
          },
          {
            paramKey: 'filter',
            label: tc('labels.status'),
            allLabel: tc('labels.all'),
            options: [{ value: 'overdue', label: ti('filters.overdue') }],
          },
        ]

  return {
    title: t('title'),
    description: t('description'),
    delegateUsers,
    tabs: tabs.map(({ key, label, count }) => ({
      key,
      href: key === 'mine' ? '/inbox' :  `/inbox?tab=${key}`,
      label,
      active: tab === key,
      count: typeof count === 'number' ? count : null,
    })),
    onSubmitted: tab === 'submitted',
    submittedEmpty: tab === 'submitted' && submittedTotal === 0,
    submittedPresent: tab === 'submitted' && submittedTotal > 0,
    gatesEmpty: showUnion && unionVisible.length === 0,
    gatesPresent: showUnion && unionVisible.length > 0,
    emptySubmittedTitle: t('emptySubmitted.title'),
    emptySubmittedDescription: t('emptySubmitted.description'),
    emptyTitle: tab === 'all' ? t('emptyAll.title') : t('empty.title'),
    emptyDescription: tab === 'all' ? t('emptyAll.description') : t('empty.description'),
    currentParams: sp,
    searchPlaceholder: tc('actions.search'),
    toolbarFilters,
    columnDocument: t('table.document'),
    columnKind: t('table.kind'),
    columnParty: tc('labels.party'),
    columnAmount: tc('labels.amount'),
    columnApproval: t('table.approval'),
    columnPendingWith: t('table.pendingWith'),
    columnWaitingSince: t('table.waitingSince'),
    columnStatus: tc('labels.status'),
    submittedRows: visibleSubmitted,
    approvalRows: unionVisible,
    bulk: tab === 'mine',
    showAssignee: tab === 'all',
    actionsEnabled: tab === 'mine' || canManageFlows,
    tabKey: tab,
    total: unionTotal,
    unfilteredTotal,
    page,
    perPage,
    paginationParams,
    submittedTotal,
    filter,
    showUnion,
    showTasks,
    tasksPresent: showTasks && taskRows.length > 0,
    tasksEmpty,
    taskRows,
    tasksEmptyTitle: ti('emptyTitle'),
    tasksEmptyDescription: ti('emptyDescription'),
    taskOpenLabel: ti('open'),
    taskActedLabel: ti('acted'),
    taskDelegatePlaceholder: ti('delegatePlaceholder'),
  }
}

const f = ref<ApprovalsData>()
const item = field
const rootF = rootRef<ApprovalsData>()

export function approvalsSpec(data: ApprovalsData): PageSpec {
  return page({
    route: '/inbox',
    layout: 'list',
    header: [
      grid('space-y-3', [
        // The tabs are the LAST header action, the house position for the
        // shared subtab strip on every page that has one. The hub used to
        // draw its own row of tab-shaped links under the header instead —
        // same job, second implementation, different treatment from every
        // other tabbed page in the product.
        pageHeader({
          title: f('title'),
          description: f('description'),
          actionsClassName: 'flex flex-wrap items-center gap-3',
          actions: [
            widget('out-of-office', { users: data.delegateUsers }),
            widget('module-home-tabs', { tabs: data.tabs }),
          ],
        }),
        widgetBlock('delegation-banner', { users: data.delegateUsers }),
      ]),
    ],
    body: [
      frame(
        'tab-content',
        [
          widgetBlock('list-toolbar', {
            basePath: '/inbox',
            currentParams: data.currentParams,
            search: { paramKey: 'q', placeholder: data.searchPlaceholder },
            filters: data.toolbarFilters,
          }),
          {
            ...widgetBlock('empty-state', {
              icon: 'send',
              title: data.emptySubmittedTitle,
              description: data.emptySubmittedDescription,
            }),
            when: f('submittedEmpty'),
          },
          {
            ...table({
              variant: 'app',
              rows: f('submittedRows'),
              rowKey: item('key'),
              columns: [
                column(
                  rootF('columnDocument'),
                  widgetCell('submitted-document-cell', {
                    documentNumber: item('documentNumber'),
                    href: item('href'),
                  }),
                  { className: 'font-mono text-[13px] font-semibold' },
                ),
                column(rootF('columnKind'), badge(item('kindLabel'), { variant: 'secondary' })),
                column(rootF('columnParty'), text(item('party'))),
                column(rootF('columnAmount'), money(item('amount')), { align: 'right' }),
                column(
                  rootF('columnApproval'),
                  widgetCell('approval-engine-cell', { name: item('engineName') }),
                ),
                column(rootF('columnPendingWith'), text(item('pendingWith'))),
                column(rootF('columnWaitingSince'), text(item('waitingSinceDate')), {
                  className: 'text-slate-500 dark:text-slate-400',
                }),
                column(rootF('columnStatus'), badge(item('statusLabel'), { variant: 'outline' })),
              ],
            }),
            when: f('submittedPresent'),
          },
          {
            ...widgetBlock('approvals-pagination', {
              params: data.paginationParams,
              total: data.submittedTotal,
              page: data.page,
              perPage: data.perPage,
            }),
            when: f('submittedPresent'),
          },
          {
            ...widgetBlock('empty-state', {
              icon: 'check-circle',
              title: data.emptyTitle,
              description: data.emptyDescription,
            }),
            when: f('gatesEmpty'),
          },
          {
            ...grid('space-y-3', [
              widgetBlock('approvals-table', {
                rows: data.approvalRows,
                users: data.delegateUsers,
                bulk: data.bulk,
                showAssignee: data.showAssignee,
                actionsEnabled: data.actionsEnabled,
              }),
              widgetBlock('approvals-pagination', {
                params: data.paginationParams,
                total: data.total,
                page: data.page,
                perPage: data.perPage,
              }),
            ]),
            when: f('gatesPresent'),
          },
          {
            ...widgetBlock('inbox-task-list', {
              rows: data.taskRows,
              users: data.delegateUsers,
              openLabel: data.taskOpenLabel,
              actedLabel: data.taskActedLabel,
              delegatePlaceholder: data.taskDelegatePlaceholder,
            }),
            when: f('tasksPresent'),
          },
          {
            ...widgetBlock('empty-state', {
              icon: 'check-circle',
              title: data.tasksEmptyTitle,
              description: data.tasksEmptyDescription,
            }),
            when: f('tasksEmpty'),
          },
        ],
        { tabKey: data.tabKey },
      ),
    ],
  })
}
