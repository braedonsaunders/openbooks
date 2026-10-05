import 'server-only'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { type Authz, can } from '@/lib/authz'
import { maySeeUnion } from '@/lib/approval-doorway'
import { approvalWorklistForAuthz, type ApprovalWorklistItem } from '@/lib/application/approvals'
import { loadPersonaMetrics, type PersonaMetrics } from './_persona'
import { randomUUID } from 'node:crypto'
import { readableContinuousCloseAgents } from '@/lib/continuous-close'
import { bankingReconCount } from '@/lib/module-home/banking'
import { resourcingHome } from '@/lib/module-home/resourcing'
import { widgetFeatureOn } from './widget-features'
import { expensesDashboard } from '@/lib/expenses-dashboard'
import { listCloseRuns } from '@/lib/application/close'
import { ApplicationError } from '@/lib/application/errors'
import { applicationContextFromSession } from '@/lib/application/context'
import { openItems } from '@/lib/cash/open-items'
import { REVENUE_TYPES } from '@/lib/reports/statements'
import { decimalRatio } from '@/lib/reports/decimals'
import { MissingRatesError, resolveSubsidiaryScope } from '@/lib/consolidation'
import { combineTotals, PNL_TYPES, statementMatrix, sumSection } from '@/lib/statement-matrix'
import type { StatementValue } from '@/lib/statement-format'
import { groupByCustomer, type CustomerReceivable } from '@/lib/cash/ar-position'
import { groupByVendor, type VendorPayable } from '@/lib/cash/ap-position'
import { cashPosition, type ApSettings } from '@/lib/cash/cash-position'
import { analyticsConfig } from '@/lib/analytics/config'
import { ANALYTICS_CONFIG } from '@/lib/analytics/config-spec'
import { MissingExchangeRateError } from '@/lib/fx-presentation'
import { WORK_ITEM_SUBJECT_JOIN, workItemSubjectScopePredicate } from '@/lib/agents/work-item-subsidiary-scope'
import {
  addDays,
  bankBalances,
  cashflowModel,
  compareMoney,
  forecastModelParams,
  normalizeMoneyValue,
  parseISO,
  paymentStats,
  scheduleForecast,
  subtractMoney,
  summariseSide,
  sumMoney,
  weekStart,
  ZERO_MONEY,
  type ForecastModelParams,
  type OpenItem,
  type PaymentStats,
} from '@/lib/cash/core'
import { presentationCurrency } from '@/lib/fx-presentation'
import { approvalRecordHref } from '@/lib/approvals-links'
import { WIDGETS } from './_widget-registry'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { MissingAccountingPeriodError, resolvePeriod, type ResolvedPeriod } from '@/lib/periods'
import type { DashboardWidgetContext } from './_metrics-context'
import { EMPTY_FINANCIAL_WIDGET_METRICS, loadFinancialWidgetMetrics, type FinancialWidgetMetrics } from './_metrics-financial'
import { EMPTY_CASH_WIDGET_METRICS, loadCashWidgetMetrics, type CashWidgetMetrics } from './_metrics-cash'
import { EMPTY_CUSTOMER_WIDGET_METRICS, loadCustomerWidgetMetrics, type CustomerWidgetMetrics } from './_metrics-customers'
import { EMPTY_VENDOR_WIDGET_METRICS, loadVendorWidgetMetrics, type VendorWidgetMetrics } from './_metrics-vendors'
import { EMPTY_PROJECT_WIDGET_METRICS, loadProjectWidgetMetrics, type ProjectWidgetMetrics } from './_metrics-projects'
import { EMPTY_RISK_WIDGET_METRICS, loadRiskWidgetMetrics, type RiskWidgetMetrics } from './_metrics-risk'

/**
 * The caller's subsidiary doorway for the consolidated P&L read: the
 * consolidated path resolves its own statement context (with windowed
 * translation rates) from the allowlist, the same doorway the /ar and /ap
 * hubs tile through — never a hand-built id list that could drift from it.
 */
export type DashboardPlScope = {
  allowed: Set<string> | null
}

export type DashboardPl = {
  revenue: string
  grossProfit: string
  expenses: string
  netIncome: string
  /** Gross-margin ratio on the 0–1 scale; null when period revenue is zero. */
  margin: string | null
  /** The currency the consolidated read returned — the tile labels this, never the org base. */
  currency: string
  /**
   * The subsidiary scope the figures cover: the consolidated node's bare
   * name plus whether it is a subtree view, so the loader can render the
   * consolidated qualifier through the catalog. The tile hint shows the
   * rendered scope, so a restricted caller scoped to one subtree never
   * reads a partial figure as the whole company. Null name for a
   * single-subsidiary org, where the scope needs no naming.
   */
  scopeName: string | null
  scopeConsolidated: boolean
}

/**
 * Period-to-date P&L through the same consolidated read as /reports/pnl: the
 * caller's subsidiary context (with its windowed translation rates) over one
 * flow column of the statement matrix, summed with the report's own section
 * helpers. A scope spanning functional currencies is translated at each
 * line-period's average rate instead of refused; a scope whose consolidated
 * rates were never derived throws MissingRatesError, which the loader maps
 * into the tiles' named refusal.
 */
export async function dashboardConsolidatedProfitAndLoss(
  from: string,
  to: string,
  periodLabel: string,
  scope: DashboardPlScope,
  orgId: string,
): Promise<DashboardPl> {
  const resolved = await resolveSubsidiaryScope(undefined, to, scope.allowed)
  if (resolved.ratesError) throw resolved.ratesError
  const matrix = await statementMatrix({
    orgId,
    types: [...PNL_TYPES],
    mode: 'flow',
    period: { from, to },
    periodLabel,
    subsidiary: resolved.subsidiary,
  })
  const revenueTotals = sumSection(matrix, [...REVENUE_TYPES])
  const cogsTotals = sumSection(matrix, ['cogs'])
  const expenseTotals = sumSection(matrix, ['expense', 'expense_other', 'expense_deferred'])
  const grossTotals = combineTotals(matrix, [revenueTotals, cogsTotals], [1, -1])
  const netTotals = combineTotals(matrix, [revenueTotals, cogsTotals, expenseTotals], [1, -1, -1])
  const first = (values: StatementValue[]): string => values[0] ?? '0.0000'
  const revenue = first(revenueTotals)
  const grossProfit = first(grossTotals)
  return {
    revenue,
    grossProfit,
    expenses: first(expenseTotals),
    netIncome: first(netTotals),
    margin: decimalRatio(grossProfit, revenue),
    currency: resolved.currency ?? await presentationCurrency(orgId),
    scopeName: resolved.nodeName ?? null,
    scopeConsolidated: resolved.consolidated,
  }
}

export type DashboardMoneyReaders = {
  bankBalances: typeof bankBalances
  openItems: typeof openItems
  paymentStats: typeof paymentStats
  profitAndLoss: typeof dashboardConsolidatedProfitAndLoss
  cashPosition: typeof cashPosition
  cashflowConfig: (orgId: string) => Promise<ApSettings & { horizonWeeks: number }>
}

const canonicalMoneyReaders: DashboardMoneyReaders = {
  bankBalances,
  openItems,
  paymentStats,
  profitAndLoss: dashboardConsolidatedProfitAndLoss,
  cashPosition,
  // The org's cashflow knobs, exactly as the banking cash page and the
  // analytics tools build them from the cashflow analytics config: the AP
  // capacity settings plus the configured default horizon and runway caution.
  // Legacy config rows without the newer keys resolve on the spec defaults.
  cashflowConfig: async (orgId: string) => {
    const cfg = await analyticsConfig(orgId, 'cashflow')
    return {
      weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)),
      restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1,
      runwayCautionWeeks: cfg.runwayCautionWeeks ?? ANALYTICS_CONFIG.cashflow.defaults.runwayCautionWeeks,
      horizonWeeks: cfg.defaultHorizonWeeks ?? ANALYTICS_CONFIG.cashflow.defaults.defaultHorizonWeeks,
    }
  },
}

export type DashboardMetrics = {
  /**
   * Org base currency labelling the cash/AR/AP/runway tiles. Null only when
   * no queried widget needs it — a tile that renders money without a
   * currency is a bug the type system refuses, so tiles render the named
   * refusal instead of formatting as dollars.
   */
  baseCurrency: string | null
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
   * Period-to-date P&L off the canonical consolidated reader (one call feeds
   * all period tiles): the organization's current fiscal period to date,
   * translated into the returned currency at each line-period's average rate.
   * Figures are null exactly when the read is refused (plUnavailable carries
   * the message) — a tile renders that refusal by name, never as a zero that
   * reads as a fact.
   */
  revenueMtd: string | null
  expensesMtd: string | null
  netIncomeMtd: string | null
  grossProfitMtd: string | null
  /** Gross-margin ratio on the 0–1 scale; null when period revenue is zero. */
  grossMarginMtd: string | null
  /** Resolved fiscal-period label the P&L tiles cover (the tile hint shows this, never "Month to date"). */
  plPeriodLabel: string | null
  /** Subsidiary scope the P&L figures cover (the tile hint shows this beside the period). */
  plScopeLabel: string | null
  /** Currency the consolidated P&L reader returned — the tile labels this, never the org base. */
  plCurrency: string | null
  /**
   * Named refusal when the consolidated P&L cannot be read (consolidated
   * rates never derived for the scope). Null when the figures above are
   * authoritative or the widget was never queried.
   */
  plUnavailable: string | null
  /**
   * Predicted collections / payments inside 30 days — the same
   * scheduleForecast prediction the AR/AP cockpits read (payment-stats
   * averages over the same open items), summed at the same +30d cut-off the
   * cockpits' expectedThisWeek/expectedNext30 use. Null when not queried.
   */
  expectedReceipts30d: string | null
  expectedPayments30d: string | null
  /**
   * Mean days to settle feeding the forecast above — the same
   * paymentStats.globalAvg the cockpits forecast from (null with no payment
   * history), surfaced on the open AR/AP tiles as hint text rather than
   * minted as tiles of their own. The tile omits the hint when null.
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
  /**
   * Named refusal when the caller holds close.run but is subsidiary-scoped:
   * close diagnostics are organization-wide, so the reader throws and this
   * carries its message. Null when the runs above are authoritative
   * (including the honest empty list) or the widget was never queried.
   */
  closeRunsUnavailable: string | null
  /**
   * Staffing pulse off the resourcing cockpit loader (same vitals, next four
   * weeks). Null when the widget was never queried or the feature is off —
   * the tile then renders its empty state, never a zero that reads as a fact.
   */
  resourcingPulse: {
    utilization: string | null
    benchPeople: number
    rolloffs: number
    overallocatedWeeks: number
  } | null
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
    /** The entry entity's functional currency — the tile formats in this, never the org currency. */
    currency: string | null
  }>
  /** Top-5 of the unified approval worklist (gates + documents + budgets). */
  pendingApprovalList: Array<{
    id: string
    targetKind: string
    targetId: string
    /** The record's approval deep link; null when the kind has no surface. */
    href: string | null
    amount: string | null
    /** Transaction currency of the amount (null for budget scenarios, which sum across entities). */
    currency: string | null
    title: string
    createdAt: string
  }>
  /**
   * Top-5 of the caller's actionable unified worklist — the same reader as
   * the tile and the /inbox tabs, so all three tie by construction.
   */
  myApprovalList: Array<{
    id: string
    targetKind: string
    targetId: string
    /** The record's approval deep link; null when the kind has no surface. */
    href: string | null
    amount: string | null
    /** Transaction currency of the amount (null for budget scenarios, which sum across entities). */
    currency: string | null
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
    /** Transaction currency of the draft total. */
    currency: string
    status: string
  }>
  // HR-15 persona-home fields (see _persona.ts). Each widget reads only
  // its own; null means absent (feature off, no source rows, or no grant)
  // and the tile renders the honest empty card, never a zero as a fact.
  inboxTasksTop: PersonaMetrics['inboxTasksTop']
  inboxApprovalsTop: PersonaMetrics['inboxApprovalsTop']
  inboxCount: PersonaMetrics['inboxCount']
  payTile: PersonaMetrics['payTile']
  balances: PersonaMetrics['balances']
  whosOut: PersonaMetrics['whosOut']
  upcoming: PersonaMetrics['upcoming']
  celebrations: PersonaMetrics['celebrations']
  announcements: PersonaMetrics['announcements']
  teamSteps: PersonaMetrics['teamSteps']
  teamNudges: PersonaMetrics['teamNudges']
  teamHeadcount: PersonaMetrics['teamHeadcount']
  teamQuals: PersonaMetrics['teamQuals']
  adminAttention: PersonaMetrics['adminAttention']
  workflowErrors: PersonaMetrics['workflowErrors']
  adminCalendar: PersonaMetrics['adminCalendar']
}
  // Widgets extracted from the Analytics dashboards, one reader module each.
  & FinancialWidgetMetrics
  & CashWidgetMetrics
  & CustomerWidgetMetrics
  & VendorWidgetMetrics
  & ProjectWidgetMetrics
  & RiskWidgetMetrics

/**
 * Bank-reconciliation queue for the dashboard tile. Returns null for a
 * caller without `banking.read` BEFORE any query runs — denial must skip
 * the reader, not merely hide its result. Counts off the same roster rows
 * the /banking workspace sums (so the tile and the cockpit tie by
 * construction) but never translates money — a missing exchange rate
 * cannot refuse a tile that shows no currency.
 */
export async function loadReconSummary(authz: Authz): Promise<{ unreconciledItems: number } | null> {
  if (!can(authz, 'banking.read')) return null
  const subIds = authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds]
  return { unreconciledItems: await bankingReconCount(authz.user.orgId, subIds) }
}

/**
 * Expense-approval queue for the dashboard tile. Returns null for a caller
 * without `expenses.read` BEFORE any query runs. Reads the pipeline section
 * of `expensesDashboard`, the same reader as the /expenses cockpit, so the
 * tile and the cockpit tie by construction.
 */
export async function loadExpenseSummary(authz: Authz): Promise<{ pendingExpenses: number } | null> {
  if (!can(authz, 'expenses.read')) return null
  const dashboard = await expensesDashboard(authz.user.orgId, authz.allowedSubsidiaryIds)
  return { pendingExpenses: dashboard.pipeline.pendingCount }
}

/**
 * Period-close readiness for the dashboard widget. Returns null for a caller
 * without `close.run` BEFORE any query runs. Reads `listCloseRuns`, the same
 * reader as the /close workspace (and orgVitals), so the widget and the
 * workspace tie by construction. A subsidiary-scoped caller holding
 * `close.run` is refused by name — the reader throws ApplicationError 403
 * (close diagnostics are organization-wide) and this rethrows; the caller
 * (loadDashboardMetrics) maps that declared outcome into
 * closeRunsUnavailable, never into an empty list that reads as "no runs".
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
  /** The entry entity's functional currency (null when the entry names no subsidiary — the left join misses — never a missing base currency, which is NOT NULL). */
  currency: string | null
}

/** The caller's own draft documents. */
interface DraftDocumentRow extends Record<string, unknown> {
  id: string
  kind: string
  document_number: string | null
  document_date: string | null
  total: string
  /** Transaction currency of the draft (documents.currency is not null). */
  currency: string
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

  // The tile links to /inbox?tab=all, so its number is the unified
  // worklist (Flows gates + gateless document approvals + pending budgets),
  // counted through the same reader as the worklist page and get_vitals —
  // never a gates-only subquery. Same doorway as get_vitals: a caller who
  // cannot approve anything has no work awaiting them.
  const mayApprove = maySeeUnion(authz)
  // Pack visibility IS the doorway: without assistant.use (plus a module
  // grant per pack) the readable set is empty and the tile counts zero.
  const agentPacks = readableContinuousCloseAgents(authz)
  const agentPackList = sql.join(agentPacks.map((pack) => sql`${pack}`), sql`, `)
  // Same subsidiary doorway as the /ar and /ap hubs (arPosition/apPosition):
  // a caller scoped to some subsidiaries tiles exactly what the hubs show
  // them, never the org-wide total.
  const subIds = authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds]
  const totalsGlScope = subsidiaryVisibleFilter(sql`g.subsidiary_id`, authz.allowedSubsidiaryIds)
  const totalsAccountScope = subsidiaryVisibleFilter(sql`a.subsidiary_id`, authz.allowedSubsidiaryIds, { orgWideNull: true })
  const totalsEntryScope = subsidiaryVisibleFilter(sql`e.subsidiary_id`, authz.allowedSubsidiaryIds)
  const recentEntryScope = subsidiaryVisibleFilter(sql`e.subsidiary_id`, authz.allowedSubsidiaryIds)
  const draftDocumentScope = subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)
  const wantTotals = need('journalLineCount', 'accountCount', 'entriesToday', 'ledgerSum')
  const wantCash = need('cashBalance')
  const wantMoney = need('baseCurrency')
  const wantAr = need('openReceivables', 'overdueReceivables', 'expectedReceipts30d', 'receivablesDso', 'topCustomers')
  const wantAp = need('openPayables', 'overduePayables', 'expectedPayments30d', 'payablesDpo', 'topVendors')
  const wantPl = need('revenueMtd', 'expensesMtd', 'netIncomeMtd', 'grossProfitMtd', 'grossMarginMtd')
  const wantArStats = need('expectedReceipts30d', 'receivablesDso')
  const wantApStats = need('expectedPayments30d', 'payablesDpo')
  const wantRunway = need('runwayWeeks', 'runwayStatus', 'projectedCash', 'lowestCash', 'lowestCashWeek')
  // The staffing pulse reads the resourcing cockpit loader — the same vitals
  // the cockpit shows. Gated on the single widget-feature map: with the
  // feature off the reader never runs and the tile renders its empty state.
  const wantResourcing = need('resourcingPulse') && (await widgetFeatureOn(orgId, 'resourcing-pulse'))
  const [totals, banks, baseCurrency, arItems, apItems, recon, expenses, closeReadiness, arStats, apStats, pl, runway, recentEntries, draftDocuments, unifiedApprovals, agentFindings, resourcingPulse] = await Promise.all([
    // Posted-ledger line count and integrity sum come from the maintained
    // gl_month_activity aggregate — counting/summing the raw lines scanned the
    // whole ledger on every dashboard render.
    wantTotals
      ? db.execute<TotalsRow>(sql`
      select
        (select coalesce(sum(g.line_count), 0) from gl_month_activity g where g.org_id = ${orgId} ${totalsGlScope}) as journal_lines,
        (select count(*) from accounts a where a.is_active and a.org_id = ${orgId} ${totalsAccountScope}) as accounts,
        (select count(*) from journal_entries e where e.org_id = ${orgId} and e.status in ('posted', 'reversed') and e.posting_date = ${today} ${totalsEntryScope}) as entries_today,
        (select coalesce(sum(g.debit_total - g.credit_total), 0) from gl_month_activity g where g.org_id = ${orgId} ${totalsGlScope}) as ledger_sum
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
    // No fabricated default and no swallowed failure: base_currency is NOT
    // NULL, so a read failure is a real defect that throws — null means the
    // base was never requested for this layout, and only then do the tiles
    // refuse by name instead of formatting figures as dollars.
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
    // Same gating shape for close.run, except the subsidiary-scope refusal is
    // a declared outcome: map the reader's forbidden into
    // closeRunsUnavailable (with an empty closeRuns), and let anything else
    // throw — the refusal must never read as "no runs".
    need('closeRuns', 'closeRunsUnavailable')
      ? loadCloseReadiness(authz)
        .then((runs) => ({ runs, unavailable: null as string | null }))
        .catch((e: unknown) => {
          if (e instanceof ApplicationError && e.code === 'forbidden') {
            return { runs: [] as DashboardMetrics['closeRuns'], unavailable: e.message as string }
          }
          throw e
        })
      : Promise.resolve({ runs: null as DashboardMetrics['closeRuns'] | null, unavailable: null as string | null }),
    // Settlement-behaviour averages behind the forecast and the DSO/DPO
    // hints — the same paymentStats reader the cockpits feed into
    // scheduleForecast, so the tile prediction and the cockpit worklist
    // agree item for item.
    wantArStats ? readers.paymentStats('ar', today, subIds, orgId) : Promise.resolve(null),
    wantApStats ? readers.paymentStats('ap', today, subIds, orgId) : Promise.resolve(null),
    // One consolidated period-to-date read feeds the revenue, expenses,
    // net-income and margin tiles — three round trips for one period would
    // triple the dashboard's heaviest reader. The window is the org's current
    // fiscal period to date (declared calendars honoured), never the civil
    // month. A scope whose consolidated rates were never derived refuses
    // inside with MissingRatesError; catch that declared outcome into nulls
    // plus the refusal message so the tiles name it, and let anything else
    // throw — an unexpected P&L failure must not masquerade as an empty
    // period. Subsidiary doorway matches the hubs: the caller's allowlist, so
    // a restricted caller tiles what /reports/pnl shows them — labelled with
    // the subtree they see, never as the whole company.
    wantPl
      ? (async () => {
        const t = await getTranslations('dashboard')
        const none = (unavailable: string, periodLabel: string | null) => ({
          revenue: null as string | null,
          expenses: null as string | null,
          netIncome: null as string | null,
          grossProfit: null as string | null,
          margin: null as string | null,
          currency: null as string | null,
          periodLabel,
          scopeName: null as string | null,
          scopeConsolidated: false,
          unavailable,
        })
        // The subsidiary scope the figures cover, qualifier rendered
        // through the catalog — never the English "(consolidated)" suffix
        // the resolver keeps for its other (report) consumers.
        const scopeLabel = (name: string | null, consolidated: boolean): string | null =>
          name === null ? null : consolidated ? t('metricContext.consolidatedScope', { name }) : name
        // The org's current fiscal period to date (declared calendars
        // honoured), resolved beside the read so the tiles can label the
        // exact window they cover. The resolution sits inside the try: when
        // today precedes the first configured accounting period it throws,
        // and that misconfiguration must refuse on the tiles — never reject
        // the whole dashboard.
        let periodLabel: string | null = null
        try {
          const period = await resolvePeriod('this_period_to_date', { orgId, today })
          // The qualifier renders through the catalog off the structured
          // label — never parsed out of English — so the hint translates.
          periodLabel = period.toDate && period.windowName
            ? t('metricContext.periodToDate', { label: period.windowName })
            : period.label
          const r = await readers.profitAndLoss(period.from, period.to, period.label, { allowed: authz.allowedSubsidiaryIds }, orgId)
          return {
            revenue: r.revenue,
            expenses: r.expenses,
            netIncome: r.netIncome,
            grossProfit: r.grossProfit,
            margin: r.margin,
            currency: r.currency,
            periodLabel,
            scopeLabel: scopeLabel(r.scopeName, r.scopeConsolidated),
            unavailable: null as string | null,
          }
        } catch (e: unknown) {
          if (e instanceof MissingRatesError) return none(e.message, periodLabel)
          // The misconfiguration refuses by type, with its date and first
          // period carried on the error — the tile renders the catalogued
          // refusal naming the Close Setup remedy, never the raw message.
          if (e instanceof MissingAccountingPeriodError) {
            return none(
              t('metricContext.noAccountingPeriod', { date: e.businessDate, period: e.firstPeriodName }),
              null,
            )
          }
          throw e
        }
      })()
      : Promise.resolve(null),
    // Whole-company liquidity off cashPosition itself — not a re-derivation
    // from its primitives, so the tile and the banking cash page cannot
    // diverge on runway, lowest point, or projected end. The org's configured
    // default horizon, the same AP capacity settings, the same caution
    // threshold, the same subsidiary doorway (unrestricted callers also match
    // root-owned rows, exactly as the
    // page's includeNullSubsidiary). A missing exchange rate refuses inside
    // as MissingExchangeRateError — the tile maps exactly that to no-data
    // (the page answers the same condition with its rates banner);
    // anything else still throws.
    wantRunway
      ? readers
        .cashflowConfig(orgId)
        .then((settings) =>
          readers.cashPosition(
            orgId,
            settings.horizonWeeks ?? ANALYTICS_CONFIG.cashflow.defaults.defaultHorizonWeeks,
            settings,
            today,
            subIds,
            authz.allowedSubsidiaryIds,
            subIds === undefined,
          ),
        )
        .then((p) => ({
          weeks: p.runwayWeeks,
          status: p.runwayStatus,
          projected: p.projectedEnd,
          lowest: p.lowestCash,
          lowestWeek: p.lowestWeek,
        }))
        .catch((e: unknown) => {
          if (e instanceof MissingExchangeRateError) return null
          throw e
        })
      : Promise.resolve(null),
    // Top-N first, then aggregate the five entries' lines — grouping before
    // the limit aggregated every entry in the tenant.
    need('recentEntries')
      ? db.execute<RecentEntryRow>(sql`
      select e.id, e.entry_number, e.posting_date, e.memo, e.status,
             lt.line_count, lt.total_debits, sub.base_currency as currency
        from (
          select id, entry_number, posting_date, memo, status, created_at, subsidiary_id
            from journal_entries e
           where e.org_id = ${orgId} and e.status in ('posted', 'reversed') ${recentEntryScope}
           order by created_at desc, entry_number desc
           limit 5
        ) e
        join lateral (
          select count(l.id) as line_count,
                 sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
            from journal_lines l where l.entry_id = e.id and l.org_id = ${orgId}
        ) lt on true
        left join subsidiaries sub on sub.id = e.subsidiary_id and sub.org_id = ${orgId}
       order by e.created_at desc, e.entry_number desc
    `)
      : Promise.resolve({ rows: [] }),
    need('draftDocuments')
      ? db.execute<DraftDocumentRow>(sql`
      select id, kind, document_number, document_date, total, currency, status
        from documents d
       where d.org_id = ${orgId} and d.status = 'draft' and d.created_by = ${userId} ${draftDocumentScope}
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
          select (count(*) filter (where w.status in ('open', 'in_review')))::int as open,
                 (count(*) filter (where w.status in ('open', 'in_review') and w.summary ? 'proposedCommand'))::int as proposals,
                 max(w.last_detected_at) as last_run
            from ai_work_items w
            ${WORK_ITEM_SUBJECT_JOIN}
           where w.org_id = ${orgId} and w.agent_key in (${agentPackList})
             ${workItemSubjectScopePredicate(orgId, authz.allowedSubsidiaryIds)}
        `)
      : Promise.resolve({ rows: [{ open: 0, proposals: 0, last_run: null }] }),
    wantResourcing
      ? resourcingHome(orgId, authz.allowedSubsidiaryIds).then((home) => ({
          utilization: home.utilization,
          benchPeople: home.benchPeople,
          rolloffs: home.rolloffs,
          overallocatedWeeks: home.overallocatedWeeks,
        }))
      : Promise.resolve(null),
  ])

  const t = totals.rows[0]!
  // Hub KPI arithmetic, exactly as arPosition/apPosition derive it from the
  // same items: outstanding minus the Current bucket (null/future due),
  // floored at zero.
  const sideTile = (items: OpenItem[]): { open: string; overdue: string } => {
    const summary = summariseSide(items, parseISO(today), ZERO_MONEY, 0)
    // Buckets match by index, never by label: summariseSide builds Current
    // first by construction (see purchasing.ts).
    const current = summary.buckets[0]?.amount ?? ZERO_MONEY
    const overdue = compareMoney(summary.outstanding, current) > 0 ? subtractMoney(summary.outstanding, current) : ZERO_MONEY
    return { open: summary.outstanding, overdue }
  }
  const arTile = sideTile(arItems)
  const apTile = sideTile(apItems)
  // Forward 30-day prediction off the same open items the stock tiles just
  // summarised: scheduleForecast with the same stats the cockpits use, cut
  // at the same +30d the cockpits' expectedNext30/dueNext30 use. The
  // schedule is bounded by the cut-off itself — a fixed week grid sized
  // from the week start can end short of it (a Saturday as-of loses days
  // 29–30) and silently drop predictions the cut-off would keep. The
  // organization's forecast-model knobs ride along, so a tuned push ladder
  // moves the tile and the cockpit together.
  const wantExpected = need('expectedReceipts30d') || need('expectedPayments30d')
  const expectedModel: ForecastModelParams = wantExpected ? await cashflowModel(orgId) : forecastModelParams({})
  const forecast30d = (items: OpenItem[], stats: PaymentStats | null): string | null => {
    if (!stats) return null
    const asOf = parseISO(today)
    const cutoff = addDays(asOf, 30)
    const forecast = scheduleForecast(items, stats, asOf, weekStart(asOf), cutoff, expectedModel)
    return sumMoney(forecast.entries.map((e) => e.amount))
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
          currency: item.currency,
          title: item.documentNumber,
          createdAt: unionRequestedAt(item),
        }
      }
      if (item.kind === 'budget') {
        return {
          id: item.id,
          targetKind: 'budget_scenario',
          targetId: item.id,
          amount: item.total,
          currency: null as string | null,
          title: item.name,
          createdAt: unionRequestedAt(item),
        }
      }
      return {
        id: item.id,
        targetKind: item.document?.kind ?? item.subjectKind,
        targetId: item.subjectId,
        amount: item.document?.total ?? null,
        currency: item.document?.currency ?? null,
        title: item.title,
        createdAt: unionRequestedAt(item),
      }
    })
    .map((row) => ({ ...row, href: approvalRecordHref(row.targetKind, row.targetId) }))
  const agent = (agentFindings as unknown as { rows: Array<{ open: number; proposals: number; last_run: string | Date | null }> }).rows[0]!
  // HR-15 persona fields: only the fields the visible widgets render are
  // queried — a denied widget's reader never runs.
  const personaKeys = [
    'inboxTasksTop', 'inboxApprovalsTop', 'inboxCount', 'payTile', 'balances',
    'whosOut', 'upcoming', 'celebrations', 'announcements', 'teamSteps',
    'teamNudges', 'teamHeadcount', 'teamQuals', 'adminAttention',
    'workflowErrors', 'adminCalendar',
  ] as const
  const personaNeeded = new Set<keyof PersonaMetrics>(
    personaKeys.filter((key) => needed.has(key)),
  )
  // Analytics widget readers: each module reads only the fields its visible
  // widgets list, over the caller's scope and the dashboards' opening period.
  let period: Promise<ResolvedPeriod> | null = null
  const widgetContext: DashboardWidgetContext = {
    authz,
    orgId,
    today,
    subsidiaryIds: subIds,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    period: () => (period ??= resolvePeriod(undefined, { orgId, today })),
  }
  const [persona, financial, cash, customers, vendors, projects, risk] = await Promise.all([
    loadPersonaMetrics(authz, personaNeeded),
    loadFinancialWidgetMetrics(widgetContext, need),
    loadCashWidgetMetrics(widgetContext, need),
    loadCustomerWidgetMetrics(widgetContext, need),
    loadVendorWidgetMetrics(widgetContext, need),
    loadProjectWidgetMetrics(widgetContext, need),
    loadRiskWidgetMetrics(widgetContext, need),
  ])
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
    expensesMtd: pl?.expenses ?? null,
    netIncomeMtd: pl?.netIncome ?? null,
    grossProfitMtd: pl?.grossProfit ?? null,
    grossMarginMtd: pl?.margin ?? null,
    plPeriodLabel: pl?.periodLabel ?? null,
    plScopeLabel: pl?.scopeLabel ?? null,
    plCurrency: pl?.currency ?? null,
    plUnavailable: pl?.unavailable ?? null,
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
    closeRuns: closeReadiness.runs ?? [],
    closeRunsUnavailable: closeReadiness.unavailable,
    resourcingPulse: resourcingPulse ?? null,
    asOfDate: today,
    recentEntries: recentEntries.rows.map((r) => ({
      id: r.id,
      entryNumber: r.entry_number,
      postingDate: r.posting_date,
      memo: r.memo,
      status: r.status,
      lineCount: Number(r.line_count),
      totalDebits: r.total_debits,
      // The entry entity's functional currency; root-owned entries carry
      // null (the left join misses) and the tile falls back to the org base.
      // There is no baseless org — base_currency is NOT NULL — so a null
      // here only means the base was never requested for this layout.
      currency: r.currency ?? baseCurrency,
    })),
    // Both widgets list the same unified worklist the tile counts:
    // top-5 oldest first, gates + gateless documents + budgets.
    pendingApprovalList: unionTop5.map((r) => ({ ...r })),
    myApprovalList: unionTop5.map((r) => ({ ...r })),
    draftDocuments: draftDocuments.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      documentNumber: r.document_number,
      documentDate: r.document_date,
      total: r.total,
      currency: r.currency,
      status: r.status,
    })),
    ...persona,
    ...EMPTY_ANALYTICS_WIDGET_METRICS,
    ...financial,
    ...cash,
    ...customers,
    ...vendors,
    ...projects,
    ...risk,
  }
}

/** Metric fields each built-in widget actually renders (see _widget-views.tsx). */
const WIDGET_METRIC_FIELDS: Record<string, readonly (keyof DashboardMetrics)[]> = {
  'kpi-journal-lines': ['journalLineCount'],
  'kpi-accounts-active': ['accountCount'],
  'kpi-entries-today': ['entriesToday'],
  'kpi-pending-approvals': ['pendingApprovals'],
  'kpi-agent-findings': ['agentFindingsOpen', 'agentFindingsProposals', 'agentFindingsLastRun'],
  'kpi-ledger-balance': ['baseCurrency', 'ledgerSum'],
  'kpi-cash-balance': ['baseCurrency', 'cashBalance', 'asOfDate'],
  'kpi-open-receivables': ['baseCurrency', 'openReceivables', 'receivablesDso', 'asOfDate'],
  'kpi-overdue-receivables': ['baseCurrency', 'overdueReceivables', 'asOfDate'],
  'kpi-open-payables': ['baseCurrency', 'openPayables', 'payablesDpo', 'asOfDate'],
  'kpi-overdue-payables': ['baseCurrency', 'overduePayables', 'asOfDate'],
  'kpi-revenue-mtd': ['plCurrency', 'plPeriodLabel', 'plScopeLabel', 'plUnavailable', 'revenueMtd', 'asOfDate'],
  'kpi-expenses-mtd': ['plCurrency', 'plPeriodLabel', 'plScopeLabel', 'plUnavailable', 'expensesMtd', 'asOfDate'],
  'kpi-net-income-mtd': ['plCurrency', 'plPeriodLabel', 'plScopeLabel', 'plUnavailable', 'netIncomeMtd', 'asOfDate'],
  'kpi-gross-margin-mtd': ['plCurrency', 'plPeriodLabel', 'plScopeLabel', 'plUnavailable', 'grossProfitMtd', 'grossMarginMtd', 'asOfDate'],
  'kpi-expected-receipts-30d': ['baseCurrency', 'expectedReceipts30d', 'asOfDate'],
  'kpi-bills-due-30d': ['baseCurrency', 'expectedPayments30d', 'asOfDate'],
  'list-top-customers': ['topCustomers'],
  'list-top-vendors': ['topVendors'],
  'kpi-cash-runway': ['baseCurrency', 'runwayWeeks', 'runwayStatus', 'projectedCash', 'lowestCash', 'lowestCashWeek', 'asOfDate'],
  'kpi-items-to-reconcile': ['unreconciledItems'],
  'kpi-expenses-awaiting-approval': ['pendingExpenses'],
  'resourcing-pulse': ['resourcingPulse'],
  'list-close-readiness': ['closeRuns', 'closeRunsUnavailable'],
  'list-recent-entries': ['recentEntries'],
  'list-pending-approvals': ['pendingApprovalList'],
  'personal-in-progress': ['draftDocuments'],
  'personal-inbox': ['myApprovalList'],
  'personal-actions': [],
  // HR-15 persona-home tiles (see _persona.ts for the readers).
  'inbox-list': ['inboxTasksTop', 'inboxCount'],
  'pay-tile': ['payTile'],
  'balance-tile': ['balances'],
  'whos-out-strip': ['whosOut'],
  'home-upcoming': ['upcoming'],
  'celebrations-list': ['celebrations'],
  'announcements-card': ['announcements'],
  'home-ask': [],
  'team-approvals': ['inboxApprovalsTop'],
  'team-steps': ['teamSteps'],
  'team-nudges': ['teamNudges'],
  'team-headcount': ['teamHeadcount'],
  'team-quals': ['teamQuals'],
  'admin-attention': ['adminAttention'],
  'workflow-errors': ['workflowErrors'],
  'admin-calendar': ['adminCalendar'],
  // ── Analytics: financial ratios and health (Financial Health) ──────────
  'ratios-profitability': ['financialSummary'],
  'ratios-liquidity': ['financialSummary'],
  'ratios-solvency': ['financialSummary'],
  'ratios-efficiency': ['financialSummary'],
  'ratios-operating': ['financialSummary'],
  'kpi-ratio-current': ['financialSummary'],
  'kpi-ratio-quick': ['financialSummary'],
  'kpi-working-capital': ['financialSummary'],
  'kpi-ratio-debt-equity': ['financialSummary'],
  'kpi-ratio-interest-coverage': ['financialSummary'],
  'kpi-ratio-roe': ['financialSummary'],
  'kpi-ratio-roic': ['financialSummary'],
  'kpi-ratio-operating-margin': ['financialSummary'],
  'kpi-ratio-net-margin': ['financialSummary'],
  'health-score': ['financialSummary'],
  'list-health-insights': ['financialInsights'],
  'chart-revenue-trend': ['financialTrend'],
  'chart-margin-trend': ['financialTrend'],
  'budget-variance': ['budgetSummary'],

  // ── Analytics: cash (Cash Flow) ─────────────────────────────────────────

  // ── Analytics: customers (Customer Intelligence) ───────────────────────
  'kpi-customer-concentration': ['concentration'],
  'kpi-customers-at-risk': ['atRisk'],
  'list-customers-at-risk': ['atRiskCustomers'],

  // ── Analytics: vendors and spend (Vendor Performance, Spend Velocity) ──

  // ── Analytics: projects (True Cost, Utilization) ───────────────────────

  // ── Analytics: risk (Sentinel) ──────────────────────────────────────────
}

const EMPTY_ANALYTICS_WIDGET_METRICS = {
  ...EMPTY_FINANCIAL_WIDGET_METRICS,
  ...EMPTY_CASH_WIDGET_METRICS,
  ...EMPTY_CUSTOMER_WIDGET_METRICS,
  ...EMPTY_VENDOR_WIDGET_METRICS,
  ...EMPTY_PROJECT_WIDGET_METRICS,
  ...EMPTY_RISK_WIDGET_METRICS,
}

const EMPTY_METRICS: DashboardMetrics = {
  baseCurrency: null,
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
  expensesMtd: null,
  netIncomeMtd: null,
  grossProfitMtd: null,
  grossMarginMtd: null,
  plPeriodLabel: null,
  plScopeLabel: null,
  plCurrency: null,
  plUnavailable: null,
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
  closeRunsUnavailable: null,
  resourcingPulse: null,
  asOfDate: '',
  recentEntries: [],
  pendingApprovalList: [],
  myApprovalList: [],
  draftDocuments: [],
  inboxTasksTop: null,
  inboxApprovalsTop: null,
  inboxCount: null,
  payTile: null,
  balances: null,
  whosOut: null,
  upcoming: null,
  celebrations: null,
  announcements: null,
  teamSteps: null,
  teamNudges: null,
  teamHeadcount: null,
  teamQuals: null,
  adminAttention: null,
  workflowErrors: null,
  adminCalendar: null,
  ...EMPTY_ANALYTICS_WIDGET_METRICS,
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
