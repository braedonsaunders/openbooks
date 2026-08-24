import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { worklistGates } from '@openbooks/engine/src/flows/index.ts'
import {
  dashboardFinancialMetricsQuery,
  type DashboardFinancialMetricsRow,
} from '@openbooks/engine/src/dashboard-reporting.ts'
import type { Authz } from '@/lib/authz'

export type DashboardMetrics = {
  baseCurrency: string
  journalLineCount: number
  accountCount: number
  entriesToday: number
  pendingApprovals: number
  ledgerSum: string
  cashBalance: string
  openReceivables: string
  overdueReceivables: string
  openPayables: string
  overduePayables: string
  recentEntries: Array<{
    id: string
    entryNumber: string | null
    postingDate: string
    memo: string | null
    status: string
    lineCount: number
    totalDebits: string
  }>
  /** Org-wide pending approval gates (flows engine). */
  pendingApprovalList: Array<{
    id: string
    targetKind: string
    targetId: string
    amount: string | null
    title: string
    createdAt: string
  }>
  /**
   * Approval gates the current user can actually decide — direct assignee,
   * role holder, or delegated-to-them — from worklistGates(), the same query
   * that backs the /approvals "mine" tab.
   */
  myApprovalList: Array<{
    id: string
    targetKind: string
    targetId: string
    amount: string | null
    title: string
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
  const today = await businessToday(orgId)

  const [totals, financials, recentEntries, pendingApprovalList, myGates, draftDocuments] = await Promise.all([
    // Posted-ledger line count and integrity sum come from the maintained
    // gl_month_activity aggregate — counting/summing the raw lines scanned the
    // whole ledger on every dashboard render.
    db.execute(sql`
      select
        (select coalesce(sum(g.line_count), 0) from gl_month_activity g where g.org_id = ${orgId}) as journal_lines,
        (select count(*) from accounts where is_active and org_id = ${orgId}) as accounts,
        (select count(*) from journal_entries where org_id = ${orgId} and status in ('posted', 'reversed') and posting_date = ${today}) as entries_today,
        (select count(*) from flow_gates where org_id = ${orgId} and status = 'pending') as pending_approvals,
        (select coalesce(sum(g.debit_total - g.credit_total), 0) from gl_month_activity g where g.org_id = ${orgId}) as ledger_sum
    `),
    db.execute(dashboardFinancialMetricsQuery(orgId, today)),
    // Top-N first, then aggregate the five entries' lines — grouping before
    // the limit aggregated every entry in the tenant.
    db.execute(sql`
      select e.id, e.entry_number, e.posting_date, e.memo, e.status,
             lt.line_count, lt.total_debits
        from (
          select id, entry_number, posting_date, memo, status, created_at
            from journal_entries
           where org_id = ${orgId} and status in ('posted', 'reversed')
           order by created_at desc, entry_number desc
           limit 5
        ) e
        join lateral (
          select count(l.id) as line_count,
                 sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
            from journal_lines l where l.entry_id = e.id and l.org_id = ${orgId}
        ) lt on true
       order by e.created_at desc, e.entry_number desc
    `),
    db.execute(sql`
      select g.id, g.title, g.subject_kind, g.subject_id, g.created_at,
             d.kind as doc_kind, d.total
        from flow_gates g
        left join documents d on d.id = g.subject_id and d.org_id = g.org_id
       where g.org_id = ${orgId} and g.status = 'pending'
       order by g.created_at desc
       limit 5
    `),
    worklistGates(orgId, userId),
    db.execute(sql`
      select id, kind, document_number, document_date, total, status
        from documents
       where org_id = ${orgId} and status = 'draft' and created_by = ${userId}
       order by updated_at desc
       limit 5
    `),
  ])

  const t = (totals as any).rows[0]
  const financial = (financials as unknown as { rows: DashboardFinancialMetricsRow[] }).rows[0]!
  return {
    baseCurrency: financial.base_currency,
    journalLineCount: Number(t.journal_lines),
    accountCount: Number(t.accounts),
    entriesToday: Number(t.entries_today),
    pendingApprovals: Number(t.pending_approvals),
    ledgerSum: t.ledger_sum,
    cashBalance: financial.cash_balance,
    openReceivables: financial.open_receivables,
    overdueReceivables: financial.overdue_receivables,
    openPayables: financial.open_payables,
    overduePayables: financial.overdue_payables,
    recentEntries: (((recentEntries)).rows).map((r: any) => ({
      id: r.id,
      entryNumber: r.entry_number,
      postingDate: r.posting_date,
      memo: r.memo,
      status: r.status,
      lineCount: Number(r.line_count),
      totalDebits: r.total_debits,
    })),
    pendingApprovalList: (((pendingApprovalList)).rows).map((r: any) => ({
      id: r.id,
      targetKind: r.doc_kind ?? r.subject_kind,
      targetId: r.subject_id,
      amount: r.total ?? null,
      title: r.title,
      createdAt:
        r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
    myApprovalList: myGates.slice(0, 5).map((g) => ({
      id: g.id,
      targetKind: g.document?.kind ?? g.subjectKind,
      targetId: g.subjectId,
      amount: g.document?.total ?? null,
      title: g.title,
      createdAt: g.createdAt instanceof Date ? g.createdAt.toISOString() : String(g.createdAt),
    })),
    draftDocuments: (((draftDocuments)).rows).map((r: any) => ({
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
  'kpi-journal-lines': ['journalLineCount'],
  'kpi-accounts-active': ['accountCount'],
  'kpi-entries-today': ['entriesToday'],
  'kpi-pending-approvals': ['pendingApprovals'],
  'kpi-ledger-balance': ['ledgerSum'],
  'kpi-cash-balance': ['baseCurrency', 'cashBalance'],
  'kpi-open-receivables': ['baseCurrency', 'openReceivables'],
  'kpi-overdue-receivables': ['baseCurrency', 'overdueReceivables'],
  'kpi-open-payables': ['baseCurrency', 'openPayables'],
  'kpi-overdue-payables': ['baseCurrency', 'overduePayables'],
  'list-recent-entries': ['recentEntries'],
  'list-pending-approvals': ['pendingApprovalList'],
  'personal-in-progress': ['draftDocuments'],
  'personal-inbox': ['myApprovalList'],
  'personal-actions': [],
}

const EMPTY_METRICS: DashboardMetrics = {
  baseCurrency: 'USD',
  journalLineCount: 0,
  accountCount: 0,
  entriesToday: 0,
  pendingApprovals: 0,
  ledgerSum: '0',
  cashBalance: '0',
  openReceivables: '0',
  overdueReceivables: '0',
  openPayables: '0',
  overduePayables: '0',
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
