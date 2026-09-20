import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { inArray, sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db, schema } from '@openbooks/engine/src/platform/db.ts'
import { type WorklistGate } from '@openbooks/engine/src/flows/index.ts'
import {
  approvalWorklistPageForAuthz,
  type ApprovalWorklistItem,
} from '../../../lib/application/approvals'
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
import { clamp, mergeHref, pickString } from '../../../lib/list-params'
import { approvalRecordHref } from '../../../lib/approvals-links'
import { pgTextArrayLiteral } from '../../../lib/pg-array'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'
import type { ApprovalRow } from './ApprovalsTable'
import type { DelegateOption } from './GateActions'

/**
 * The approval hub, split into a loader and a spec.
 *
 * Three searchParam-driven tabs over the Flows engine:
 *
 *   • mine      — everything I can act on (direct, role, delegated-to-me),
 *                 with counts-by-kind chips, aging, and bulk approve/reject.
 *   • submitted — where MY documents are: who they're pending with, since when.
 *   • all       — org-wide pending items (flows.manage / admin only).
 *
 * `all` is gated on `flows.manage` in the LOADER, before the query runs — an
 * unauthorized `?tab=all` falls back to `mine` rather than rendering an empty
 * org-wide list, which would still leak that the tab exists.
 *
 * The body is wrapped in `TabContent`, which is a component rather than a div,
 * so this is the first page to use a `frame`: a named host wrapper with
 * spec-authored children.
 */

type Tab = 'mine' | 'submitted' | 'all'

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
  showChips: boolean
  chips: { kind: string; label: string; count: number; active: boolean; href: string }[]
  clearHref: string | null
  clearLabel: string
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
}

export async function loadApprovals(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApprovalsData | null> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('approvals')
  const tc = await getTranslations('common')
  const authz = await getAuthz()
  if (!authz) return null
  const user = authz.user
  const orgId = user.orgId
  const canManageFlows = can(authz, 'flows.manage')
  const canSeeAll = canManageFlows

  const rawTab = pickString(sp.tab)
  const tab: Tab =
    rawTab === 'submitted' ? 'submitted' : rawTab === 'all' && canSeeAll ? 'all' : 'mine'
  const kindFilter = pickString(sp.kind) || undefined

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
  // no rows rather than a forbidden error.
  const mayApprove =
    can(authz, 'flows.approve') || can(authz, 'ap.approve') || can(authz, 'ar.approve') || can(authz, 'budgets.approve')
  // One server-side page over the union: each leg fetches its leading
  // offset+limit rows in SQL and the total/chips come from aggregates, so no
  // request ever scans a whole leg. Same reader family as the dashboard tile
  // (approvalWorklistForAuthz), same doorway, same per-item shape.
  const unionPage = mayApprove
    ? await approvalWorklistPageForAuthz(authz, { limit: perPage, offset, kind: kindFilter })
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
    return {
      key: `gate:${g.id}`,
      gateId: g.id,
      documentNumber: g.document?.documentNumber ?? g.subjectLabel ?? g.subjectId.slice(0, 8),
      kind,
      kindLabel: kindLabel(kind),
      href: g.href ?? approvalRecordHref(kind, g.subjectId),
      party: g.document?.partyName ?? null,
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

  // ---- Kind chips (mine/all tabs) -------------------------------------------
  // Counts come from the union aggregates (unfiltered by kind, sorted by code
  // so chip order is stable across locales); the rows arrive kind-filtered
  // from SQL, so there is deliberately no second filter here.
  const rowsForTab = tab === 'all' ? allRows : mineRows
  const chipCounts = new Map<string, number>(
    [...unionPage.kindCounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  const visibleRows = rowsForTab
  const visibleSubmitted = submittedRows

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'mine', label: t('tabs.mine'), count: mineCount },
    { key: 'submitted', label: t('tabs.submitted') },
    ...(canSeeAll ? [{ key: 'all' as Tab, label: t('tabs.all') }] : []),
  ]

  return {
    title: t('title'),
    description: t('description'),
    delegateUsers,
    tabs: tabs.map(({ key, label, count }) => ({
      key,
      href: key === 'mine' ? '/approvals' : `/approvals?tab=${key}`,
      label,
      active: tab === key,
      count: typeof count === 'number' ? count : null,
    })),
    onSubmitted: tab === 'submitted',
    submittedEmpty: tab === 'submitted' && submittedTotal === 0,
    submittedPresent: tab === 'submitted' && submittedTotal > 0,
    gatesEmpty: tab !== 'submitted' && unfilteredTotal === 0,
    gatesPresent: tab !== 'submitted' && unfilteredTotal > 0,
    emptySubmittedTitle: t('emptySubmitted.title'),
    emptySubmittedDescription: t('emptySubmitted.description'),
    emptyTitle: tab === 'all' ? t('emptyAll.title') : t('empty.title'),
    emptyDescription: tab === 'all' ? t('emptyAll.description') : t('empty.description'),
    showChips: tab !== 'submitted' && chipCounts.size > 0,
    chips: [...chipCounts.entries()].map(([kind, count]) => ({
      kind,
      label: kindLabel(kind),
      count,
      active: kindFilter === kind,
      // A new filter restarts at page one: the old page may not exist.
      href: mergeHref('/approvals', sp, {
        kind: kindFilter === kind ? undefined : kind,
        page: undefined,
      }),
    })),
    clearHref: kindFilter
      ? mergeHref('/approvals', sp, { kind: undefined, page: undefined })
      : null,
    clearLabel: tc('labels.all'),
    columnDocument: t('table.document'),
    columnKind: t('table.kind'),
    columnParty: tc('labels.party'),
    columnAmount: tc('labels.amount'),
    columnApproval: t('table.approval'),
    columnPendingWith: t('table.pendingWith'),
    columnWaitingSince: t('table.waitingSince'),
    columnStatus: tc('labels.status'),
    submittedRows: visibleSubmitted,
    approvalRows: visibleRows,
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
  }
}

const f = ref<ApprovalsData>()
const item = field
const rootF = rootRef<ApprovalsData>()

export function approvalsSpec(data: ApprovalsData): PageSpec {
  return page({
    route: '/approvals',
    layout: 'list',
    header: [
      grid('space-y-3', [
        pageHeader({
          title: f('title'),
          description: f('description'),
          actions: [widget('out-of-office', { users: data.delegateUsers })],
        }),
        widgetBlock('delegation-banner', { users: data.delegateUsers }),
        widgetBlock('approval-tabs', { tabs: data.tabs }),
      ]),
    ],
    body: [
      frame(
        'tab-content',
        [
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
              {
                ...widgetBlock('kind-chips', {
                  chips: data.chips,
                  clearHref: data.clearHref,
                  clearLabel: data.clearLabel,
                }),
                when: f('showChips'),
              },
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
        ],
        { tabKey: data.tabKey },
      ),
    ],
  })
}
