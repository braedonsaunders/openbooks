import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { Authz } from '@/lib/authz'

export type DashboardMetrics = {
  journalEntryCount: number
  journalLineCount: number
  accountCount: number
  partyCount: number
  entriesToday: number
  pendingApprovals: number
  ledgerSum: string
  recentEntries: Array<{
    id: string
    entryNumber: string | null
    postingDate: string
    memo: string | null
    status: string
    lineCount: number
    totalDebits: string
  }>
  pendingApprovalList: Array<{
    id: string
    targetKind: string
    targetId: string
    amount: string | null
    status: string
    currentStep: number
    createdAt: string
  }>
  /**
   * Approvals the current user can actually decide: pending requests whose
   * current step is assigned to the user's role (admins see everything),
   * mirroring the /approvals worklist query in engine/src/approvals.ts.
   * Approval steps have no per-user assignment (assignee_party_id has no
   * linkage to users), so role assignment is the personal scope.
   */
  myApprovalList: Array<{
    id: string
    targetKind: string
    targetId: string
    amount: string | null
    status: string
    currentStep: number
    createdAt: string
  }>
  draftDocuments: Array<{
    id: string
    kind: string
    documentNumber: string
    documentDate: string
    total: string
    status: string
  }>
}

export async function loadDashboardMetrics(authz: Authz): Promise<DashboardMetrics> {
  const orgId = authz.user.orgId
  const userId = authz.user.id
  const role = authz.user.role

  const [totals, recentEntries, pendingApprovalList, myApprovalList, draftDocuments] = await Promise.all([
    db.execute(sql`
      select
        (select count(*) from journal_entries where org_id = ${orgId} and status = 'posted') as journal_entries,
        (select count(*) from journal_lines l join journal_entries e on e.id = l.entry_id where e.org_id = ${orgId} and e.status = 'posted') as journal_lines,
        (select count(*) from accounts where is_active and org_id = ${orgId}) as accounts,
        (select count(*) from parties where org_id = ${orgId}) as parties,
        (select count(*) from journal_entries where org_id = ${orgId} and status = 'posted' and posting_date = current_date) as entries_today,
        (select count(*) from approval_requests where org_id = ${orgId} and status = 'pending') as pending_approvals,
        (select coalesce(sum(l.amount), 0) from journal_lines l join journal_entries e on e.id = l.entry_id where e.org_id = ${orgId}) as ledger_sum
    `),
    db.execute(sql`
      select e.id, e.entry_number, e.posting_date, e.memo, e.status,
             count(l.id) as line_count,
             sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
        from journal_entries e
        join journal_lines l on l.entry_id = e.id
       where e.org_id = ${orgId} and e.status = 'posted'
       group by e.id
       order by e.created_at desc, e.entry_number desc
       limit 5
    `),
    db.execute(sql`
      select id, target_kind, target_id, amount, status, current_step, created_at
        from approval_requests
       where org_id = ${orgId} and status = 'pending'
       order by created_at desc
       limit 5
    `),
    db.execute(sql`
      select r.id, r.target_kind, r.target_id, r.amount, r.status, r.current_step, r.created_at
        from approval_requests r
        join approval_steps s
          on s.request_id = r.id
         and s.step_number = r.current_step
         and s.decision = 'pending'
       where r.org_id = ${orgId} and r.status = 'pending'
         and (s.assignee_role = ${role} or ${role} = 'admin')
       order by r.created_at desc
       limit 5
    `),
    db.execute(sql`
      select id, kind, document_number, document_date, total, status
        from documents
       where org_id = ${orgId} and status = 'draft' and created_by = ${userId}
       order by updated_at desc
       limit 5
    `),
  ])

  const t = (totals as any).rows[0]
  return {
    journalEntryCount: Number(t.journal_entries),
    journalLineCount: Number(t.journal_lines),
    accountCount: Number(t.accounts),
    partyCount: Number(t.parties),
    entriesToday: Number(t.entries_today),
    pendingApprovals: Number(t.pending_approvals),
    ledgerSum: t.ledger_sum,
    recentEntries: ((recentEntries as any).rows).map((r: any) => ({
      id: r.id,
      entryNumber: r.entry_number,
      postingDate: r.posting_date,
      memo: r.memo,
      status: r.status,
      lineCount: Number(r.line_count),
      totalDebits: r.total_debits,
    })),
    pendingApprovalList: ((pendingApprovalList as any).rows).map((r: any) => ({
      id: r.id,
      targetKind: r.target_kind,
      targetId: r.target_id,
      amount: r.amount,
      status: r.status,
      currentStep: Number(r.current_step),
      createdAt: r.created_at,
    })),
    myApprovalList: ((myApprovalList as any).rows).map((r: any) => ({
      id: r.id,
      targetKind: r.target_kind,
      targetId: r.target_id,
      amount: r.amount,
      status: r.status,
      currentStep: Number(r.current_step),
      createdAt: r.created_at,
    })),
    draftDocuments: ((draftDocuments as any).rows).map((r: any) => ({
      id: r.id,
      kind: r.kind,
      documentNumber: r.document_number,
      documentDate: r.document_date,
      total: r.total,
      status: r.status,
    })),
  }
}

/** Metric fields each built-in widget actually renders (see _widget-views.tsx). */
const WIDGET_METRIC_FIELDS: Record<string, readonly (keyof DashboardMetrics)[]> = {
  'kpi-journal-entries': ['journalEntryCount'],
  'kpi-journal-lines': ['journalLineCount'],
  'kpi-accounts-active': ['accountCount'],
  'kpi-parties': ['partyCount'],
  'kpi-entries-today': ['entriesToday'],
  'kpi-pending-approvals': ['pendingApprovals'],
  'kpi-ledger-balance': ['ledgerSum'],
  'list-recent-entries': ['recentEntries'],
  'list-pending-approvals': ['pendingApprovalList'],
  'personal-in-progress': ['draftDocuments'],
  'personal-inbox': ['myApprovalList'],
  'personal-actions': [],
}

const EMPTY_METRICS: DashboardMetrics = {
  journalEntryCount: 0,
  journalLineCount: 0,
  accountCount: 0,
  partyCount: 0,
  entriesToday: 0,
  pendingApprovals: 0,
  ledgerSum: '0',
  recentEntries: [],
  pendingApprovalList: [],
  myApprovalList: [],
  draftDocuments: [],
}

/**
 * Server-side payload minimisation: return a DashboardMetrics carrying only
 * the fields the given widgets render, with everything else zeroed/emptied,
 * so client components never receive metrics their widgets don't need.
 */
export function pruneDashboardMetrics(
  metrics: DashboardMetrics,
  widgetIds: readonly string[],
): DashboardMetrics {
  const pruned: DashboardMetrics = { ...EMPTY_METRICS }
  for (const id of widgetIds) {
    for (const field of WIDGET_METRIC_FIELDS[id] ?? []) {
      ;(pruned as Record<keyof DashboardMetrics, unknown>)[field] = metrics[field]
    }
  }
  return pruned
}
