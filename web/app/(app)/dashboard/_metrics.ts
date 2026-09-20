import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday, startOfMonth } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { type Authz, can } from '@/lib/authz'
import { approvalWorklistForAuthz, type ApprovalWorklistItem } from '@/lib/application/approvals'
import { randomUUID } from 'node:crypto'
import { readableContinuousCloseAgents } from '@/lib/continuous-close'
import { bankingHome } from '@/lib/module-home/banking'
import { expensesDashboard } from '@/lib/expenses-dashboard'
import { listCloseRuns } from '@/lib/application/close'
import { applicationContextFromSession } from '@/lib/application/context'
import { openItems } from '@/lib/cash/open-items'
import { profitAndLoss } from '@/lib/reports/statements'
import { ReportCurrencyBasisError } from '@/lib/reports/currency-basis'
import { decimalRatio } from '@/lib/reports/decimals'
import { groupByCustomer, type CustomerReceivable } from '@/lib/cash/ar-position'
import { groupByVendor, type VendorPayable } from '@/lib/cash/ap-position'
import { cashPosition } from '@/lib/cash/cash-position'
import { analyticsConfig } from '@/lib/analytics/config'
import { MissingRatesError } from '@/lib/consolidation'
import {
  addDays,
  bankBalances,
  buildWeekGrid,
  compareMoney,
  normalizeMoneyValue,
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
  cashPosition: typeof cashPosition
  cashflowConfig: (orgId: string) => Promise<{ weeklyCap: string; restrictToSafe: boolean }>
}

const canonicalMoneyReaders: DashboardMoneyReaders = {
  bankBalances,
  openItems,
  paymentStats,
  profitAndLoss,
  cashPosition,
  // The org's AP capacity-scheduling knobs, exactly as the banking cash page
  // and the analytics tools build them from the cashflow analytics config.
  cashflowConfig: async (orgId: string) => {
    const cfg = await analyticsConfig(orgId, 'cashflow')
    return { weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)), restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  },
}

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
  /**
   * Cash runway off the canonical cashPosition reader — the same 8-week
   * horizon the banking cash page opens on, the same AP settings, the same
   * subsidiary doorway. Null when not queried, or when the FX-rate pipeline
   * is blocked (the page shows its rates banner; the tile shows no-data).
   */
  runwayWeeks: string | null
  runwayStatus: 'healthy' | 'caution' | 'critical' | null
  projectedCash: string | null
  lowestCash: string | null
  lowestCashWeek: string | null
  /** Unmatched bank statement lines awaiting reconciliation. A count, never
   * money — there is no currency to mix, by construction. */
  unreconciledItems: number
  /** Expense reports in `pending_approval`. A count only: the cockpit
   * reader's pipeline totals sum raw multi-currency totals org-wide, so the
   * tile deliberately does not touch them. */
  pendingExpenses: number
  /** Latest close runs (period, book, status, stage, target date) — the same
   * rows as the /close workspace's recent-runs list. No money involved. */
  closeRuns: Array<{
    id: string
    period: string
    book: string
    status: string
    stage: string | null
    targetCloseDate: string | null
  }>
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
    /** Null until the document is numbered, which drafts may not be yet. */
    documentNumber: string | null
    /** Null while the author has not dated the draft. */
    documentDate: string | null
    total: string
    status: string
  }>
}

/**
 * Bank-reconciliation queue for the dashboard tile. Returns null for a
 * caller without `banking.read` BEFORE any query runs — denial must skip
 * the reader, not merely hide its result. Reads `bankingHome`, the same
 * reader as the /banking cockpit and its Match-button count, so the tile
 * and the cockpit tie by construction.
 */
export async function loadReconSummary(authz: Authz): Promise<{ unreconciledItems: number } | null> {
  if (!can(authz, 'banking.read')) return null
  const subIds = authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds]
  const home = await bankingHome(authz.user.orgId, subIds)
  return { unreconciledItems: home.unmatchedLines }
}

/**
 * Expense-approval queue for the dashboard tile. Returns null for a caller
 * without `expenses.read` BEFORE any query runs. Reads the pipeline section
 * of `expensesDashboard`, the same reader as the /expenses cockpit, so the
 * tile and the cockpit tie by construction.
 */
export async function loadExpenseSummary(authz: Authz): Promise<{ pendingExpenses: number } | null> {
  if (!can(authz, 'expenses.read')) return null
  const dashboard = await expensesDashboard(authz.user.orgId)
  return { pendingExpenses: dashboard.pipeline.pendingCount }
}

/**
 * Period-close readiness for the dashboard widget. Returns null for a caller
 * without `close.run` BEFORE any query runs. Reads `listCloseRuns`, the same
 * reader as the /close workspace (and orgVitals), so the widget and the
 * workspace tie by construction. Subsidiary-scoped callers read [] from the
 * reader itself — the widget reports that honestly as empty.
 */
export async function loadCloseReadiness(authz: Authz): Promise<DashboardMetrics['closeRuns'] | null> {
  if (!can(authz, 'close.run')) return null
  const runs = await listCloseRuns(applicationContextFromSession(authz, 'api', randomUUID()), { limit: 5 })
  return runs.map((run) => ({
    id: run.id,
    period: run.periodName,
    book: run.bookCode,
    status: run.status,
    stage: run.currentStage,
    targetCloseDate: run.targetCloseDate,
  }))
}

/** Ledger totals tile. Counts and sums arrive from the driver as strings. */
interface TotalsRow extends Record<string, unknown> {
  journal_lines: string | number
  accounts: string | number
  entries_today: string | number
  ledger_sum: string
}

/** Recent posted entries, with the per-entry line rollup joined on. */
interface RecentEntryRow extends Record<string, unknown> {
  id: string
  entry_number: string | null
  posting_date: string
  memo: string | null
  status: string
  line_count: string | number
  total_debits: string
}

/** The caller's own draft documents. */
interface DraftDocumentRow extends Record<string, unknown> {
  id: string
  kind: string
  document_number: string | null
  document_date: string | null
  total: string
  status: string
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
  const wantRunway = need('runwayWeeks', 'runwayStatus', 'projectedCash', 'lowestCash', 'lowestCashWeek')
  const [totals, banks, baseCurrency, arItems, apItems, recon, expenses, closeRuns, arStats, apStats, pl, runway, recentEntries, draftDocuments, unifiedApprovals, agentFindings] = await Promise.all([
    // Posted-ledger line count and integrity sum come from the maintained
    // gl_month_activity aggregate — counting/summing the raw lines scanned the
    // whole ledger on every dashboard render.
    wantTotals
      ? db.execute<TotalsRow>(sql`
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
    // Gated inside on banking.read (null with no query for denied callers),
    // and on the visible widget set — a layout without the tile never runs
    // the reader at all.
    need('unreconciledItems') ? loadReconSummary(authz) : Promise.resolve(null),
    // Same gating shape for expenses.read.
    need('pendingExpenses') ? loadExpenseSummary(authz) : Promise.resolve(null),
    // Same gating shape for close.run.
    need('closeRuns') ? loadCloseReadiness(authz) : Promise.resolve(null),
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
    // Whole-company liquidity off cashPosition itself — not a re-derivation
    // from its primitives, so the tile and the banking cash page cannot
    // diverge on runway, lowest point, or projected end. Same 8-week horizon
    // the page opens on, same AP capacity settings, same subsidiary doorway
    // (unrestricted callers also match root-owned rows, exactly as the
    // page's includeNullSubsidiary). A blocked FX-rate pipeline refuses
    // inside with MissingRatesError — the page answers with its rates
    // banner, the tile with no-data; anything else throws.
    wantRunway
      ? readers
        .cashflowConfig(orgId)
        .then((settings) =>
          readers.cashPosition(orgId, 8, settings, today, subIds, authz.allowedSubsidiaryIds, subIds === undefined),
        )
        .then((p) => ({
          weeks: p.runwayWeeks,
          status: p.runwayStatus,
          projected: p.projectedEnd,
          lowest: p.lowestCash,
          lowestWeek: p.lowestWeek,
        }))
        .catch((e: unknown) => {
          if (e instanceof MissingRatesError) return null
          throw e
        })
      : Promise.resolve(null),
    // Top-N first, then aggregate the five entries' lines — grouping before
    // the limit aggregated every entry in the tenant.
    need('recentEntries')
      ? db.execute<RecentEntryRow>(sql`
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
      ? db.execute<DraftDocumentRow>(sql`
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

  const t = totals.rows[0]!
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
    runwayWeeks: runway?.weeks ?? null,
    runwayStatus: runway?.status ?? null,
    projectedCash: runway?.projected ?? null,
    lowestCash: runway?.lowest ?? null,
    lowestCashWeek: runway?.lowestWeek ?? null,
    unreconciledItems: recon?.unreconciledItems ?? 0,
    pendingExpenses: expenses?.pendingExpenses ?? 0,
    closeRuns: closeRuns ?? [],
    asOfDate: today,
    recentEntries: recentEntries.rows.map((r) => ({
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
    draftDocuments: draftDocuments.rows.map((r) => ({
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
  'kpi-cash-runway': ['baseCurrency', 'runwayWeeks', 'runwayStatus', 'projectedCash', 'lowestCash', 'lowestCashWeek', 'asOfDate'],
  'kpi-items-to-reconcile': ['unreconciledItems'],
  'kpi-expenses-awaiting-approval': ['pendingExpenses'],
  'list-close-readiness': ['closeRuns'],
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
  runwayWeeks: null,
  runwayStatus: null,
  projectedCash: null,
  lowestCash: null,
  lowestCashWeek: null,
  unreconciledItems: 0,
  pendingExpenses: 0,
  closeRuns: [],
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
