import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { type Authz, can } from '@/lib/authz'
import { approvalWorklistForAuthz, type ApprovalWorklistItem } from '@/lib/application/approvals'
import { readableContinuousCloseAgents } from '@/lib/continuous-close'
import { openItems } from '@/lib/cash/open-items'
import {
  bankBalances,
  compareMoney,
  parseISO,
  subtractMoney,
  summariseSide,
  sumMoney,
  ZERO_MONEY,
  type OpenItem,
} from '@/lib/cash/core'
import { presentationCurrency } from '@/lib/fx-presentation'

export type DashboardMetrics = {
  baseCurrency: string
  journalLineCount: number
  accountCount: number
  entriesToday: number
  pendingApprovals: number
  /** Open (open/in_review) findings over the caller's readable agent packs. */
  agentFindingsOpen: number
  /** ...of which carry a proposed command. */
  agentFindingsProposals: number
  /** Latest detection instant across readable packs (the tile's "last run"). */
  agentFindingsLastRun: string | null
  ledgerSum: string
  cashBalance: string
  openReceivables: string
  overdueReceivables: string
  openPayables: string
  overduePayables: string
  /** Business day the as-of readers (cash, open AR/AP) were cut — the tiles
   * label it so a figure that excludes future-dated documents says so. */
  asOfDate: string
  recentEntries: Array<{
    id: string
    entryNumber: string | null
    postingDate: string
    memo: string | null
    status: string
    lineCount: number
    totalDebits: string
  }>
  /** Top-5 of the unified approval worklist (gates + documents + pay runs). */
  pendingApprovalList: Array<{
    id: string
    targetKind: string
    targetId: string
    amount: string | null
    title: string
    createdAt: string
  }>
  /**
   * Top-5 of the caller's actionable unified worklist — the same reader as
   * the tile and the /approvals tabs, so all three tie by construction.
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

  // The tile links to /approvals?tab=all, so its number is the unified
  // worklist (Flows gates + gateless document approvals + pending pay runs),
  // counted through the same reader as the worklist page and get_vitals —
  // never a gates-only subquery. Same doorway as get_vitals: a caller who
  // cannot approve anything has no work awaiting them.
  const mayApprove = can(authz, 'flows.approve') || can(authz, 'ap.approve') || can(authz, 'ar.approve')
  // Pack visibility IS the doorway: without assistant.use (plus a module
  // grant per pack) the readable set is empty and the tile counts zero.
  const agentPacks = readableContinuousCloseAgents(authz)
  const agentPackList = sql.join(agentPacks.map((pack) => sql`${pack}`), sql`, `)
  // Same subsidiary doorway as the /ar and /ap hubs (arPosition/apPosition):
  // a caller scoped to some subsidiaries tiles exactly what the hubs show
  // them, never the org-wide total.
  const subIds = authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds]
  const [totals, banks, baseCurrency, arItems, apItems, recentEntries, draftDocuments, unifiedApprovals, agentFindings] = await Promise.all([
    // Posted-ledger line count and integrity sum come from the maintained
    // gl_month_activity aggregate — counting/summing the raw lines scanned the
    // whole ledger on every dashboard render.
    db.execute(sql`
      select
        (select coalesce(sum(g.line_count), 0) from gl_month_activity g where g.org_id = ${orgId}) as journal_lines,
        (select count(*) from accounts where is_active and org_id = ${orgId}) as accounts,
        (select count(*) from journal_entries where org_id = ${orgId} and status in ('posted', 'reversed') and posting_date = ${today}) as entries_today,
        (select coalesce(sum(g.debit_total - g.credit_total), 0) from gl_month_activity g where g.org_id = ${orgId}) as ledger_sum
    `),
    // Cash at bank is the cockpit's per-account reader, summed — the same
    // doorway as the /banking cockpit and the forecast's startingCash, so
    // same-labeled figures tie by construction. It is subsidiary-scoped,
    // excludes inactive/summary bank accounts, and translates each leg at the
    // closing spot; the previous org-wide asset_bank sum counted those
    // accounts and added mixed functionals raw (F-u1-P4). Missing FX coverage
    // fails closed inside (the hub contract), never a silently mixed tile.
    bankBalances(today, subIds, orgId),
    presentationCurrency(orgId),
    // The AR/AP tiles read the shared open-item reader — the same doorway as
    // the /ar and /ap hubs and the aging report — so same-labeled figures tie
    // by construction. Missing FX coverage fails closed inside (the hub
    // contract), never a silently undercounted tile.
    openItems(orgId, 'ar', today, subIds),
    openItems(orgId, 'ap', today, subIds),
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
      select id, kind, document_number, document_date, total, status
        from documents
       where org_id = ${orgId} and status = 'draft' and created_by = ${userId}
       order by updated_at desc
       limit 5
    `),
    mayApprove ? approvalWorklistForAuthz(authz) : Promise.resolve([]),
    // One row, three numbers: open findings, open findings with a proposal,
    // and the latest detection across readable packs. Same scope as the
    // workbench inbox, never a parallel count.
    agentPacks.length > 0
      ? db.execute(sql`
          select (count(*) filter (where status in ('open', 'in_review')))::int as open,
                 (count(*) filter (where status in ('open', 'in_review') and summary ? 'proposedCommand'))::int as proposals,
                 max(last_detected_at) as last_run
            from ai_work_items
           where org_id = ${orgId} and agent_key in (${agentPackList})
        `)
      : Promise.resolve({ rows: [{ open: 0, proposals: 0, last_run: null }] }),
  ])

  const t = (totals as any).rows[0]
  // Hub KPI arithmetic, exactly as arPosition/apPosition derive it from the
  // same items: outstanding minus the Current bucket (null/future due),
  // floored at zero.
  const sideTile = (items: OpenItem[]): { open: string; overdue: string } => {
    const summary = summariseSide(items, parseISO(today), ZERO_MONEY, 0)
    const current = summary.buckets.find((b) => b.label === 'Current')?.amount ?? ZERO_MONEY
    const overdue = compareMoney(summary.outstanding, current) > 0 ? subtractMoney(summary.outstanding, current) : ZERO_MONEY
    return { open: summary.outstanding, overdue }
  }
  const arTile = sideTile(arItems)
  const apTile = sideTile(apItems)
  const unionRequestedAt = (item: ApprovalWorklistItem): string => {
    const raw =
      item.kind === 'flow_gate' ? item.createdAt : (item.submittedAt ?? item.createdAt)
    return raw instanceof Date ? raw.toISOString() : raw
  }
  const unionTop5 = [...unifiedApprovals]
    .sort((a, b) => unionRequestedAt(a).localeCompare(unionRequestedAt(b)))
    .slice(0, 5)
    .map((item) => {
      if (item.kind === 'document') {
        return {
          id: item.id,
          targetKind: item.docKind,
          targetId: item.id,
          amount: item.total,
          title: item.documentNumber,
          createdAt: unionRequestedAt(item),
        }
      }
      if (item.kind === 'pay_run') {
        return {
          id: item.id,
          targetKind: 'pay_run',
          targetId: item.id,
          amount: item.totalAmount,
          title: item.runNumber,
          createdAt: unionRequestedAt(item),
        }
      }
      if (item.kind === 'budget') {
        return {
          id: item.id,
          targetKind: 'budget_scenario',
          targetId: item.id,
          amount: item.total,
          title: item.name,
          createdAt: unionRequestedAt(item),
        }
      }
      return {
        id: item.id,
        targetKind: item.document?.kind ?? item.subjectKind,
        targetId: item.subjectId,
        amount: item.document?.total ?? null,
        title: item.title,
        createdAt: unionRequestedAt(item),
      }
    })
  const agent = (agentFindings as unknown as { rows: Array<{ open: number; proposals: number; last_run: string | Date | null }> }).rows[0]!
  return {
    baseCurrency,
    journalLineCount: Number(t.journal_lines),
    accountCount: Number(t.accounts),
    entriesToday: Number(t.entries_today),
    pendingApprovals: unifiedApprovals.length,
    agentFindingsOpen: Number(agent.open),
    agentFindingsProposals: Number(agent.proposals),
    agentFindingsLastRun: agent.last_run ? new Date(agent.last_run).toISOString() : null,
    ledgerSum: t.ledger_sum,
    cashBalance: sumMoney(banks.map((b) => b.balance)),
    openReceivables: arTile.open,
    overdueReceivables: arTile.overdue,
    openPayables: apTile.open,
    overduePayables: apTile.overdue,
    asOfDate: today,
    recentEntries: (((recentEntries)).rows).map((r: any) => ({
      id: r.id,
      entryNumber: r.entry_number,
      postingDate: r.posting_date,
      memo: r.memo,
      status: r.status,
      lineCount: Number(r.line_count),
      totalDebits: r.total_debits,
    })),
    // Both widgets list the same unified worklist the tile counts (F-t01-007):
    // top-5 oldest first, gates + gateless documents + pay runs.
    pendingApprovalList: unionTop5.map((r) => ({ ...r })),
    myApprovalList: unionTop5.map((r) => ({ ...r })),
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
  'kpi-agent-findings': ['agentFindingsOpen', 'agentFindingsProposals', 'agentFindingsLastRun'],
  'kpi-ledger-balance': ['ledgerSum'],
  'kpi-cash-balance': ['baseCurrency', 'cashBalance', 'asOfDate'],
  'kpi-open-receivables': ['baseCurrency', 'openReceivables', 'asOfDate'],
  'kpi-overdue-receivables': ['baseCurrency', 'overdueReceivables', 'asOfDate'],
  'kpi-open-payables': ['baseCurrency', 'openPayables', 'asOfDate'],
  'kpi-overdue-payables': ['baseCurrency', 'overduePayables', 'asOfDate'],
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
  agentFindingsOpen: 0,
  agentFindingsProposals: 0,
  agentFindingsLastRun: null,
  ledgerSum: '0',
  cashBalance: '0',
  openReceivables: '0',
  overdueReceivables: '0',
  openPayables: '0',
  overduePayables: '0',
  asOfDate: '',
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
