import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday, startOfMonth } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { type Authz, can } from '@/lib/authz'
import { approvalWorklistForAuthz, type ApprovalWorklistItem } from '@/lib/application/approvals'
import { readableContinuousCloseAgents } from '@/lib/continuous-close'
import { openItems } from '@/lib/cash/open-items'
import { profitAndLoss } from '@/lib/reports/statements'
import { ReportCurrencyBasisError } from '@/lib/reports/currency-basis'
import { decimalRatio } from '@/lib/reports/decimals'
import { groupByCustomer, type CustomerReceivable } from '@/lib/cash/ar-position'
import { groupByVendor, type VendorPayable } from '@/lib/cash/ap-position'
import {
  addDays,
  bankBalances,
  buildWeekGrid,
  compareMoney,
  parseISO,
  paymentStats,
  scheduleForecast,
  subtractMoney,
  summariseSide,
  sumMoney,
  toISO,
  ZERO_MONEY,
  type OpenItem,
  type PaymentStats,
} from '@/lib/cash/core'
import { presentationCurrency } from '@/lib/fx-presentation'
import { WIDGETS } from './_widget-registry'

/**
 * The money readers the dashboard loads through, injectable so tests can
 * prove the denial path: a widget the caller cannot see must not merely
 * render absent — its reader must never run. Production always passes the
 * canonical readers (the default); tests pass spies.
 */
export type DashboardMoneyReaders = {
  bankBalances: typeof bankBalances
  openItems: typeof openItems
  paymentStats: typeof paymentStats
  profitAndLoss: typeof profitAndLoss
}

const canonicalMoneyReaders: DashboardMoneyReaders = { bankBalances, openItems, paymentStats, profitAndLoss }

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
  /**
   * Month-to-date P&L off the canonical profitAndLoss reader (one call feeds
   * all three tiles). Null when the subsidiary scope spans functional
   * currencies — the reader refuses rather than mixing, and a tile must
   * render that as no-data ("—"), never as a zero that reads as a fact.
   */
  revenueMtd: string | null
  netIncomeMtd: string | null
  grossProfitMtd: string | null
  /** Gross-margin ratio on the 0–1 scale; null when MTD revenue is zero. */
  grossMarginMtd: string | null
  /**
   * Predicted collections / payments inside 30 days — the same
   * scheduleForecast prediction the AR/AP cockpits read (payment-stats
   * averages over the same open items), summed at the same +30d cut-off the
   * cockpits' expectedThisWeek/expectedNext30 use. Null when not queried.
   */
  expectedReceipts30d: string | null
  expectedPayments30d: string | null
  /**
   * Collection / payment day averages feeding the forecast above — the same
   * paymentStats.globalAvg the cockpits label DSO/DPO, surfaced on the open
   * AR/AP tiles as hint text rather than minted as tiles of their own.
   */
  receivablesDso: number | null
  payablesDpo: number | null
  /**
   * Top-5 balances by party off the same open items the stock tiles read,
   * through the same groupByCustomer/groupByVendor rollups the AR/AP
   * cockpits list — largest first. Null when not queried; an empty array
   * renders the honest empty card, never a zero row.
   */
  topCustomers: CustomerReceivable[] | null
  topVendors: VendorPayable[] | null
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

export async function loadDashboardMetrics(
  authz: Authz,
  /**
   * Widget ids the caller may see (already passed through canSeeWidget by
   * loadDashboardView / loadDashboardEditCanvas). Only the metric fields
   * those widgets render are queried — a denied widget's reader never runs,
   * so absence on screen means absence from the query log too. Defaults to
   * every built-in widget, which is exactly what the loader did before the
   * filter existed.
   */
  widgetIds: readonly string[] = Object.keys(WIDGETS),
  readers: DashboardMoneyReaders = canonicalMoneyReaders,
): Promise<DashboardMetrics> {
  const orgId = authz.user.orgId
  const userId = authz.user.id
  const today = await businessToday(orgId)
  const needed = new Set<keyof DashboardMetrics>()
  for (const id of widgetIds) {
    for (const field of WIDGET_METRIC_FIELDS[id] ?? []) needed.add(field)
  }
  // One predicate per reader group below: no needed field, no query.
  const need = (...fields: (keyof DashboardMetrics)[]): boolean =>
    fields.some((f) => needed.has(f))

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
  const wantTotals = need('journalLineCount', 'accountCount', 'entriesToday', 'ledgerSum')
  const wantCash = need('cashBalance')
  const wantMoney = need('baseCurrency')
  const wantAr = need('openReceivables', 'overdueReceivables', 'expectedReceipts30d', 'receivablesDso', 'topCustomers')
  const wantAp = need('openPayables', 'overduePayables', 'expectedPayments30d', 'payablesDpo', 'topVendors')
  const wantPl = need('revenueMtd', 'netIncomeMtd', 'grossProfitMtd', 'grossMarginMtd')
  const wantArStats = need('expectedReceipts30d', 'receivablesDso')
  const wantApStats = need('expectedPayments30d', 'payablesDpo')
  const [totals, banks, baseCurrency, arItems, apItems, arStats, apStats, pl, recentEntries, draftDocuments, unifiedApprovals, agentFindings] = await Promise.all([
    // Posted-ledger line count and integrity sum come from the maintained
    // gl_month_activity aggregate — counting/summing the raw lines scanned the
    // whole ledger on every dashboard render.
    wantTotals
      ? db.execute(sql`
      select
        (select coalesce(sum(g.line_count), 0) from gl_month_activity g where g.org_id = ${orgId}) as journal_lines,
        (select count(*) from accounts where is_active and org_id = ${orgId}) as accounts,
        (select count(*) from journal_entries where org_id = ${orgId} and status in ('posted', 'reversed') and posting_date = ${today}) as entries_today,
        (select coalesce(sum(g.debit_total - g.credit_total), 0) from gl_month_activity g where g.org_id = ${orgId}) as ledger_sum
    `)
      : Promise.resolve({ rows: [{ journal_lines: 0, accounts: 0, entries_today: 0, ledger_sum: '0' }] }),
    // Cash at bank is the cockpit's per-account reader, summed — the same
    // doorway as the /banking cockpit and the forecast's startingCash, so
    // same-labeled figures tie by construction. It is subsidiary-scoped,
    // excludes inactive/summary bank accounts, and translates each leg at the
    // closing spot; the previous org-wide asset_bank sum counted those
    // accounts and added mixed functionals raw (F-u1-P4). Missing FX coverage
    // fails closed inside (the hub contract), never a silently mixed tile.
    wantCash ? readers.bankBalances(today, subIds, orgId) : Promise.resolve([]),
    wantMoney ? presentationCurrency(orgId) : Promise.resolve(EMPTY_METRICS.baseCurrency),
    // The AR/AP tiles read the shared open-item reader — the same doorway as
    // the /ar and /ap hubs and the aging report — so same-labeled figures tie
    // by construction. Missing FX coverage fails closed inside (the hub
    // contract), never a silently undercounted tile.
    wantAr ? readers.openItems(orgId, 'ar', today, subIds) : Promise.resolve([]),
    wantAp ? readers.openItems(orgId, 'ap', today, subIds) : Promise.resolve([]),
    // Settlement-behaviour averages behind the forecast and the DSO/DPO
    // hints — the same paymentStats reader the cockpits feed into
    // scheduleForecast, so the tile prediction and the cockpit worklist
    // agree item for item.
    wantArStats ? readers.paymentStats('ar', today, subIds, orgId) : Promise.resolve(null),
    wantApStats ? readers.paymentStats('ap', today, subIds, orgId) : Promise.resolve(null),
    // One MTD profitAndLoss call feeds the revenue, net-income and margin
    // tiles — three round trips for one period would triple the dashboard's
    // heaviest reader. A multi-functional scope refuses inside (the report
    // contract, pinned by report-currency-basis); catch that declared
    // outcome into nulls so the tiles render no-data, and let anything else
    // throw — an unexpected P&L failure must not masquerade as an empty
    // month. Subsidiary doorway matches the hubs: the caller's scope, so a
    // restricted caller tiles what /reports/pnl shows them.
    wantPl
      ? readers
        .profitAndLoss(startOfMonth(today), today, { subsidiaryIds: subIds }, orgId)
        .then((r) => ({
          revenue: r.revenue,
          netIncome: r.netIncome,
          grossProfit: r.grossProfit,
          margin: decimalRatio(r.grossProfit, r.revenue),
        }))
        .catch((e: unknown) => {
          if (e instanceof ReportCurrencyBasisError) return null
          throw e
        })
      : Promise.resolve(null),
    // Top-N first, then aggregate the five entries' lines — grouping before
    // the limit aggregated every entry in the tenant.
    need('recentEntries')
      ? db.execute(sql`
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
    `)
      : Promise.resolve({ rows: [] }),
    need('draftDocuments')
      ? db.execute(sql`
      select id, kind, document_number, document_date, total, status
        from documents
       where org_id = ${orgId} and status = 'draft' and created_by = ${userId}
       order by updated_at desc
       limit 5
    `)
      : Promise.resolve({ rows: [] }),
    mayApprove && need('pendingApprovals', 'pendingApprovalList', 'myApprovalList')
      ? approvalWorklistForAuthz(authz)
      : Promise.resolve([]),
    // One row, three numbers: open findings, open findings with a proposal,
    // and the latest detection across readable packs. Same scope as the
    // workbench inbox, never a parallel count.
    agentPacks.length > 0 && need('agentFindingsOpen', 'agentFindingsProposals', 'agentFindingsLastRun')
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
  // Forward 30-day prediction off the same open items the stock tiles just
  // summarised: scheduleForecast with the same stats the cockpits use, cut
  // at the same +30d the cockpits' expectedNext30/dueNext30 use (a 5-week
  // grid covers the cut-off either way — the grid only bounds the
  // prediction, the cut-off selects it).
  const forecast30d = (items: OpenItem[], stats: PaymentStats | null): string | null => {
    if (!stats) return null
    const grid = buildWeekGrid(today, 5)
    const forecast = scheduleForecast(items, stats, grid.asOf, grid.start, grid.end)
    const cutoff = toISO(addDays(grid.asOf, 30))
    return sumMoney(forecast.entries.filter((e) => e.predictedDate <= cutoff).map((e) => e.amount))
  }
  const expectedReceipts = need('expectedReceipts30d') ? forecast30d(arItems, arStats) : null
  const expectedPayments = need('expectedPayments30d') ? forecast30d(apItems, apStats) : null
  // Party rollups over the identical item arrays — groupBy sorts largest
  // first, the tile takes five. Same functions as the cockpits, so a
  // customer never owes one figure on the dashboard and another on /ar.
  const asOfDay = parseISO(today)
  const topCustomers = need('topCustomers') ? groupByCustomer(arItems, asOfDay).slice(0, 5) : null
  const topVendors = need('topVendors') ? groupByVendor(apItems, asOfDay).slice(0, 5) : null
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
    revenueMtd: pl?.revenue ?? null,
    netIncomeMtd: pl?.netIncome ?? null,
    grossProfitMtd: pl?.grossProfit ?? null,
    grossMarginMtd: pl?.margin ?? null,
    expectedReceipts30d: expectedReceipts,
    expectedPayments30d: expectedPayments,
    receivablesDso: arStats?.globalAvg ?? null,
    payablesDpo: apStats?.globalAvg ?? null,
    topCustomers,
    topVendors,
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
  'kpi-open-receivables': ['baseCurrency', 'openReceivables', 'receivablesDso', 'asOfDate'],
  'kpi-overdue-receivables': ['baseCurrency', 'overdueReceivables', 'asOfDate'],
  'kpi-open-payables': ['baseCurrency', 'openPayables', 'payablesDpo', 'asOfDate'],
  'kpi-overdue-payables': ['baseCurrency', 'overduePayables', 'asOfDate'],
  'kpi-revenue-mtd': ['baseCurrency', 'revenueMtd', 'asOfDate'],
  'kpi-net-income-mtd': ['baseCurrency', 'netIncomeMtd', 'asOfDate'],
  'kpi-gross-margin-mtd': ['baseCurrency', 'grossProfitMtd', 'grossMarginMtd', 'asOfDate'],
  'kpi-expected-receipts-30d': ['baseCurrency', 'expectedReceipts30d', 'asOfDate'],
  'kpi-bills-due-30d': ['baseCurrency', 'expectedPayments30d', 'asOfDate'],
  'list-top-customers': ['topCustomers'],
  'list-top-vendors': ['topVendors'],
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
  revenueMtd: null,
  netIncomeMtd: null,
  grossProfitMtd: null,
  grossMarginMtd: null,
  expectedReceipts30d: null,
  expectedPayments30d: null,
  receivablesDso: null,
  payablesDpo: null,
  topCustomers: null,
  topVendors: null,
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
