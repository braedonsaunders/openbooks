import "server-only";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { statementBookExpr } from "../gl-summary";
import { REVENUE_TYPES } from "../reports/statements";
import { addMonthsIso } from "@openbooks/reports";
import { getMoneyFormatter } from '../money-server'
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { analyticsConfig } from "./config";
import { englishCustomerStrings, type CustomerStrings } from "./customer-strings";
import { paymentStats } from "../cash/core";
import { isFeatureEnabled } from "../features";
import { flowRates } from "../fx-presentation";
import { add, mulDecimal, neg } from "@openbooks/engine/src/money/money.ts";
import { PNL_COST_TYPES, PNL_TYPES } from "../account-types";

/**
 * Customer Intelligence — the data behind /analytics/customer-intelligence.
 * Every subsystem and its exact parameters:
 *  - Money (TWO measures, one definition each — fleet8 P3):
 *     * revenue = RECOGNIZED (ASC 606): net income-account postings per
 *       customer — the same universe the P&L reads (REVENUE_TYPES, statement
 *       book, posted/reversed entries), net of credit memos, voids netting to
 *       zero. Attribution is line party_id plus recognition schedules through
 *       their contract customer (those legs carry no party).
 *     * invoicedRevenue = BILLINGS: posted, non-voided customer-invoice
 *       document totals at the document rate — gross of credits, includes
 *       sales tax, blind to deferral. The reconciling column, never the
 *       headline.
 *     * recon bridges them per customer: invoiced − recognized =
 *       tax + credits + (timingDeferred − timingRecognized) + voids + other.
 *     Recognition cancellations attribute through the schedule
 *     reversal_journal_entry_id back-link (both the flipped original and the
 *     mirror land in voids); the mirror period ties to the P&L exactly.
 *     Known edge (F-p2-002): a voided invoice's prior-period reversed
 *     recognition has no population row, so the org total trails the P&L by
 *     exactly those legs until the population rule learns ledger presence.
 *    Population, invoice counts, avg invoice value and first/last dates stay
 *    document-based (billing activity); every `revenue` roll-up (rows, KPIs,
 *    segments, tiers, monthly trend, cohorts) is recognized.
 *  - Base metrics: per-customer invoice count / invoiced + recognized revenue /
 *    avg invoice value / first-last dates / recency / tenure.
 *  - RFM: R from fixed day thresholds (≤30→5, ≤90→3, ≤180→2, else 1); F/M from
 *    33rd/66th percentile cuts ({1,3,5} scores); 8 behavioural segments
 *    (champions/loyal/new/potential/hibernating/lost/at-risk/regular).
 *  - CLV: annual value = avgTxnValue × (txnCount / max(0.25, tenureYears));
 *    retention = clamp(0.95·e^(−daysSinceLast/120), 0.10–0.95); projected CLV =
 *    annual × 3y × retention; percentile tiers top10/30/60 → platinum/gold/silver.
 *  - Churn: composite 0–100 (recency 40/25/10 at >120/>60/>30d; personal-cadence
 *    decline 30/15 at 2×/1.5×; engagement 30/15 at ≤1/≤3 txns), levels ≥70
 *    critical / ≥50 high / ≥30 medium, retention probability = 100 − score.
 *  - Friction: credits×2 (+returns×3 — no return-auth kind in this ledger, so
 *    returns are always 0, stated in the UI); levels ≥10pts|≥20% critical,
 *    ≥5|≥10% high, ≥2|≥5% medium.
 *  - Velocity: avg days between orders (tenure/(txns−1)); overdue vs cadence;
 *    urgency critical >1× / high >0.5× / medium >0 / due-soon ≤7d.
 *  - Payment: paid = fully-applied invoices; days-to-pay = final application
 *    date − invoice date (the closedate−trandate); score 100 −40/−20/−10
 *    by DSO >60/>30/>15 − min(40, overdue×10); ratings 80/60/40.
 *  - Growth: monthly revenue/customers/new-customers with median-based mature
 *    months (10% floor), MoM capped +200/−80, YoY = last-3mo vs months −15..−12,
 *    trend = recent-6 vs prior-6 ±10%.
 *  - Cohorts: lifetime by first-order year; active = ordered in last 6 months.
 *  - Health: weighted (R25/F25/M30/Payment20 as 20×score) − friction penalty
 *    (25/15/8), grades A+≥90 A≥80 B≥70 C≥60 D≥50 F, 7-priority recommendation.
 *  - Intelligence score: 0.3×min(100, champions%×5) + 0.3×avgRetentionProb +
 *    0.2×concentrationHealth(90/60/30) + 0.2×paymentRate.
 */

/* --------------------------------------------------------------- constants */
// Default values (Lib_CustomerValue_Data.js).
const W_RECENCY = 0.25;
const W_FREQUENCY = 0.25;
const W_MONETARY = 0.3;
const W_PAYMENT = 0.2;
const RECENCY_GOOD = 30;
const RECENCY_WARNING = 90;
const RECENCY_CRITICAL = 180;
const CHURN_HIGH_DAYS = 120;
const CHURN_MEDIUM_DAYS = 60;

/**
 * The formal P&L universe (and its cost side) as SQL `IN` fragments — the
 * single shared definition in lib/account-types, so the project slice sums
 * to the headline P&L. Never hand-write a type list for these here.
 */
const PNL_TYPES_SQL = sql.join(
  PNL_TYPES.map((t) => sql`${t}`),
  sql`, `,
);
const PNL_COST_TYPES_SQL = sql.join(
  PNL_COST_TYPES.map((t) => sql`${t}`),
  sql`, `,
);

export type Tier = "platinum" | "gold" | "silver" | "bronze";
export type Segment = "champions" | "loyal" | "potential" | "new" | "regular" | "hibernating" | "at-risk" | "lost";
export type RiskLevel = "critical" | "high" | "medium" | "low";
export type Recommendation = "resolve-issues" | "reactivate" | "win-back" | "nurture" | "onboard" | "reprice" | "review" | "maintain";

/**
 * The bridge between the two customer money questions. All legs are signed
 * contributions to (invoiced − recognized), so:
 *   invoiced − recognized = tax + credits + (timingDeferred − timingRecognized) + voids + other
 * Positive rows explain why invoiced exceeds recognized; negative rows (notably
 * timingRecognized, and voids in the original period of a cross-period void)
 * explain why recognized exceeds invoiced.
 */
export interface CustomerRevenueRecon {
  /** Sales tax inside invoiced document totals: collected-tax postings on
   *  invoice-sourced, non-reversed entries. Credit-memo tax relief is in NO
   *  row — it touches neither invoiced nor recognized — and reversed entries
   *  ride with voids. */
  tax: number;
  /** Credit memos: income-leg relief (debit postings to income accounts) on
   *  credit-sourced, non-reversed entries. The sales-tax relief on those same
   *  memos is deliberately NOT here — it touches neither invoiced nor
   *  recognized, so including it would break the bridge identity. */
  credits: number;
  /** Billed but not yet earned: invoice net routed to a deferred-liability
   *  account instead of income this period (ASC 606 timing). */
  timingDeferred: number;
  /** Earned but not billed this period: revenue-recognition schedule postings
   *  attributed through the contract customer (those legs carry no party_id). */
  timingRecognized: number;
  /** Net income effect of reversed entries and their mirrors in this period.
   *  Same-period voids net to zero here; a cross-period void reads positive in
   *  the reversal period and negative in the original period. */
  voids: number;
  /** Residual: manual-journal income with a party tag and FX/rounding dust —
   *  anything outside the buckets above. Persistently large `other` for a
   *  customer means a posting path the recon does not model yet. */
  other: number;
}

export interface CustomerRow {
  id: string;
  name: string;
  // base metrics
  /**
   * RECOGNIZED revenue (ASC 606): net income-account postings attributed to
   * this customer in the period — the same universe the P&L reads
   * (REVENUE_TYPES, statement book, posted/reversed entries), net of credit
   * memos. Compare with `invoicedRevenue`; the `recon` bridge explains the gap.
   */
  revenue: number;
  /** Prior-period recognized revenue (YoY base for `revenue`). */
  priorRevenue: number;
  /**
   * INVOICED revenue (billings): posted, non-voided customer-invoice document
   * totals translated at the document rate. Gross of credit memos, includes
   * sales tax, blind to deferred recognition — the cash/AR/sales-comp question,
   * kept as the explicitly labelled reconciling column, never the headline.
   */
  invoicedRevenue: number;
  /** The invoiced→recognized bridge; see CustomerRevenueRecon. */
  recon: CustomerRevenueRecon;
  yoyPct: number | null;
  invoices: number;
  avgInvoice: number;
  firstInvoice: string | null;
  lastInvoice: string | null;
  recencyDays: number;
  tenureDays: number;
  // RFM
  rfm: { r: number; f: number; m: number; score: number; code: string };
  segment: Segment;
  // CLV
  annualValue: number;
  clv: number; // projected
  retentionFactor: number; // 0–100
  tier: Tier;
  clvRank: number;
  // churn
  churnScore: number;
  churnLevel: RiskLevel;
  churnFactors: string[];
  retentionProbability: number;
  avgDaysBetween: number;
  // friction
  frictionPoints: number;
  frictionLevel: RiskLevel;
  creditCount: number;
  creditValue: number;
  returnRate: number;
  // velocity
  avgOrderCycle: number;
  daysOverdue: number;
  urgency: "critical" | "high" | "medium" | "due-soon" | "on-track";
  // payment
  paymentScore: number;
  paymentRating: "excellent" | "good" | "fair" | "poor" | "unknown";
  avgDaysToPay: number | null;
  overdueCount: number;
  paymentRate: number | null;
  // concentration
  sharePct: number; // 0–100
  concentrationRisk: RiskLevel;
  // profitability merge
  grossProfit: number | null;
  marginPct: number | null; // percentage points
  isFakeChampion: boolean;
  jobs: number;
  // health
  healthScore: number;
  healthGrade: "A+" | "A" | "B" | "C" | "D" | "F";
  recommendation: Recommendation;
  recommendationDetail: string;
  scoreBreakdown: { recency: number; frequency: number; monetary: number; payment: number; frictionPenalty: number };
}

export interface SegmentStat {
  segment: Segment;
  count: number;
  percentage: number;
  /** Recognized revenue in the period (ledger, net of credit memos). */
  totalRevenue: number;
  avgRevenue: number;
  /** Invoiced revenue in the period (billings, reconciling column). */
  totalInvoiced: number;
}

export interface MonthlyGrowth {
  month: string;
  label: string;
  /** Recognized revenue in the month (ledger, net of credit memos). */
  revenue: number;
  /** Invoiced revenue in the month (billings, reconciling series). */
  invoiced: number;
  uniqueCustomers: number;
  transactionCount: number;
  newCustomers: number;
  growthRate: number | null; // null = ramp-up period
  isMature: boolean;
}

export interface Cohort {
  year: string;
  totalCustomers: number;
  activeCustomers: number;
  retentionRate: number;
  /** Lifetime recognized revenue (ledger, net of credit memos). */
  totalRevenue: number;
  avgRevenue: number;
  /** Lifetime invoiced revenue (billings, reconciling column). */
  totalInvoiced: number;
}

export interface Insight {
  type: "info" | "warning" | "success" | "alert";
  category: string;
  title: string;
  message: string;
  impact: "high" | "medium" | "low";
  action?: string;
}

export interface CustomerData {
  period: { from: string; to: string; label: string };
  rows: CustomerRow[];
  intelligence: { score: number; label: string; grade: string };
  kpis: {
    totalCustomers: number;
    /** Period recognized revenue across all customers (ties to P&L revenue). */
    totalRevenue: number;
    /** Period invoiced revenue across all customers (reconciling total). */
    totalInvoiced: number;
    avgCustomerValue: number;
    projectedClv: number;
    avgClv: number;
    champions: number;
    atRiskCount: number;
    atRiskRevenue: number;
    retentionRate: number; // avg retention probability
    paymentRate: number;
    avgDaysToPay: number;
    top10PctShare: number;
    hhiScaled: number; // 0–10000
    hhiLevel: "high" | "moderate" | "low";
    customersFor80Pct: number;
    topCustomerShare: number;
    monthlyGrowth: number;
    yoyGrowth: number | null;
    newCustomers: number;
    overdueInvoices: number;
    overdueOrders: number;
    criticalFriction: number;
    highFriction: number;
    fakeChampions: number;
  };
  segments: SegmentStat[];
  tierBreakdown: { tier: Tier; count: number; revenue: number; invoiced: number; threshold: number }[];
  growth: {
    monthly: MonthlyGrowth[];
    yoyGrowth: number | null;
    avgMonthlyGrowth: number;
    medianMonthlyRevenue: number;
    totalNewCustomers: number;
    trend: "growing" | "declining" | "stable";
  };
  cohorts: { list: Cohort[]; overallRetention: number };
  insights: Insight[];
  /** Effective tunable thresholds (org overrides over defaults). */
  config: {
    churnCriticalScore: number;
    churnHighScore: number;
    churnMediumScore: number;
    hhiWarning: number;
    hhiCritical: number;
    clvYears: number;
  };
}

/* ------------------------------------------------------------ Profitability */
// Project-financials profitability (faithful; kept from the first port), plus
// the fake-champion flag (revenue > $100k ∧ margin < 15%).

export type ProfitTier = "high" | "medium" | "low" | "marginal" | "loss";

export interface ProfitJob {
  jobId: string;
  jobName: string;
  revenue: number;
  costs: number;
  profit: number;
  marginPct: number; // percentage points (24.7 not 0.247)
  transactionCount: number;
}

export interface ProfitCustomer {
  customerId: string;
  customerName: string;
  totalRevenue: number;
  totalCost: number;
  grossProfit: number;
  marginPct: number;
  profitTier: ProfitTier;
  isFakeChampion: boolean;
  jobs: ProfitJob[];
}

export interface ProfitabilitySummary {
  totalRevenue: number;
  totalCost: number;
  totalGrossProfit: number;
  avgMarginPct: number;
  customerCount: number;
  totalJobs: number;
  fakeChampions: number;
  tierBreakdown: Record<ProfitTier, number>;
}

export interface Profitability {
  customers: ProfitCustomer[];
  summary: ProfitabilitySummary;
}

type CustomerSqlNumeric = string | number | null;

interface ProfitabilitySqlRow {
  customer_id: string;
  customer_name: string;
  job_id: string;
  job_name: string;
  revenue: CustomerSqlNumeric;
  costs: CustomerSqlNumeric;
  txns: CustomerSqlNumeric;
}

interface CustomerBaseSqlRow {
  id: string;
  name: string;
  func: string | null;
  revenue: CustomerSqlNumeric;
  txn_count: CustomerSqlNumeric;
  late: string | null;
  first_txn: unknown;
  last_txn: unknown;
}

interface CustomerFrictionSqlRow {
  id: string;
  func: string | null;
  credit_count: CustomerSqlNumeric;
  order_count: CustomerSqlNumeric;
  credit_value: CustomerSqlNumeric;
  late: string | null;
}

interface CustomerPaymentSqlRow {
  id: string;
  invoice_count: CustomerSqlNumeric;
  paid_count: CustomerSqlNumeric;
  overdue_count: CustomerSqlNumeric;
  avg_days_to_pay: CustomerSqlNumeric;
}

interface CustomerGrowthSqlRow {
  month: string;
  func: string | null;
  revenue: CustomerSqlNumeric;
  unique_customers: CustomerSqlNumeric;
  txn_count: CustomerSqlNumeric;
  new_customers: CustomerSqlNumeric;
  late: string | null;
}

function profitTierOf(marginPct: number): ProfitTier {
  if (marginPct >= 40) return "high";
  if (marginPct >= 25) return "medium";
  if (marginPct >= 10) return "low";
  if (marginPct >= 0) return "marginal";
  return "loss";
}

function emptyProfitability(): Profitability {
  return {
    customers: [],
    summary: {
      totalRevenue: 0,
      totalCost: 0,
      totalGrossProfit: 0,
      avgMarginPct: 0,
      customerCount: 0,
      totalJobs: 0,
      fakeChampions: 0,
      tierBreakdown: { high: 0, medium: 0, low: 0, marginal: 0, loss: 0 },
    },
  };
}

export async function customerProfitability(
  period: { from: string; to: string },
  orgId: string,
  allowed: ReadonlySet<string> | null,
  strings: CustomerStrings = englishCustomerStrings,
): Promise<Profitability> {
  // Job-costed margins join `projects`. When Projects is off that register is
  // not a live module — an empty result is not "no jobs this period".
  if (!orgId || !(await isFeatureEnabled(orgId, "projects"))) return emptyProfitability();
  const { from, to } = period;
  const orgFilter = orgId ? sql`and l.org_id = ${orgId}` : sql``;
  // The entry window materializes first. Joined inline, the planner drives
  // from accounts and probes the entry primary key once per journal line in
  // the tenant before the date filter narrows anything.
  const r = ((await db.execute(sql`
    with ew as materialized (
      select id, org_id, posting_date from journal_entries
       where posting_date >= ${from} and posting_date <= ${to}
         ${orgId ? sql`and org_id = ${orgId}` : sql``}
         and status in ('posted', 'reversed') and book_id = ${statementBookExpr(orgId)}
    )
    select pr.customer_id as customer_id,
      coalesce(cp.display_name, 'Unknown') as customer_name,
      pr.id as job_id,
      coalesce(pr.name, 'Untitled project') as job_name,
      sub.base_currency as func,
      max(e.posting_date)::text as late,
      -sum(case when a.type in ('income','income_other') then l.amount else 0 end) as revenue,
      sum(case when a.type in (${PNL_COST_TYPES_SQL}) then l.amount else 0 end) as costs,
      count(distinct e.id) as txns
    from ew e
    join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    join projects pr on pr.id = l.project_id and pr.org_id = l.org_id
    join parties cp on cp.id = pr.customer_id and cp.org_id = pr.org_id
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
    where a.type in (${PNL_TYPES_SQL})
      and l.project_id is not null and pr.customer_id is not null
      ${orgFilter}
      ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      ${subsidiaryVisibleFilter(sql`pr.subsidiary_id`, allowed)}
    group by pr.customer_id, cp.display_name, pr.id, pr.name, sub.base_currency
  `)));

  // Legs are stamped in their line entity's functional: translate each
  // (job, functional) leg at its latest posting date, then merge per job.
  interface ProfitLeg extends ProfitabilitySqlRow { func: string | null; late: string | null }
  const legs = r.rows as unknown as ProfitLeg[];
  const profitCtx = await flowRates(orgId, legs.map((leg) => ({
    func: leg.func ?? null,
    date: (leg.late ?? to).slice(0, 10),
  })));
  const byCustomer = new Map<string, ProfitCustomer>();
  const byJob = new Map<string, { customer_id: string; customer_name: string; job_id: string; job_name: string; revenue: string; costs: string; txns: number }>();
  for (const leg of legs) {
    const key = `${leg.customer_id} ${leg.job_id}`;
    const date = (leg.late ?? to).slice(0, 10);
    const cur = byJob.get(key) ?? {
      customer_id: leg.customer_id, customer_name: leg.customer_name,
      job_id: leg.job_id, job_name: leg.job_name, revenue: "0", costs: "0", txns: 0,
    };
    cur.revenue = add(cur.revenue, mulDecimal(String(leg.revenue ?? 0), profitCtx.rateAt(leg.func ?? null, date)));
    cur.costs = add(cur.costs, mulDecimal(String(leg.costs ?? 0), profitCtx.rateAt(leg.func ?? null, date)));
    cur.txns += Number(leg.txns ?? 0);
    byJob.set(key, cur);
  }
  for (const merged of byJob.values()) {
    const revenue = Number(merged.revenue);
    const costs = Number(merged.costs);
    const profit = revenue - costs;
    // Skip empty projects (no revenue and no cost).
    if (revenue === 0 && costs === 0) continue;
    const job: ProfitJob = {
      jobId: merged.job_id,
      jobName: strings.displayJobName(merged.job_name),
      revenue,
      costs,
      profit,
      marginPct: revenue > 0 ? (profit / revenue) * 100 : 0,
      transactionCount: merged.txns,
    };
    let c = byCustomer.get(merged.customer_id);
    if (!c) {
      c = { customerId: merged.customer_id, customerName: strings.displayCustomerName(merged.customer_name), totalRevenue: 0, totalCost: 0, grossProfit: 0, marginPct: 0, profitTier: "marginal", isFakeChampion: false, jobs: [] };
      byCustomer.set(merged.customer_id, c);
    }
    c.jobs.push(job);
    c.totalRevenue += revenue;
    c.totalCost += costs;
  }

  const tierBreakdown: Record<ProfitTier, number> = { high: 0, medium: 0, low: 0, marginal: 0, loss: 0 };
  const customers = [...byCustomer.values()].map((c) => {
    c.grossProfit = c.totalRevenue - c.totalCost;
    c.marginPct = c.totalRevenue > 0 ? (c.grossProfit / c.totalRevenue) * 100 : 0;
    c.profitTier = profitTierOf(c.marginPct);
    c.isFakeChampion = c.totalRevenue > 100_000 && c.marginPct < 15;
    c.jobs.sort((a, b) => b.revenue - a.revenue);
    tierBreakdown[c.profitTier]++;
    return c;
  });
  customers.sort((a, b) => b.totalRevenue - a.totalRevenue);

  const totalRevenue = customers.reduce((a, c) => a + c.totalRevenue, 0);
  const totalCost = customers.reduce((a, c) => a + c.totalCost, 0);
  const totalGrossProfit = totalRevenue - totalCost;

  return {
    customers,
    summary: {
      totalRevenue,
      totalCost,
      totalGrossProfit,
      avgMarginPct: totalRevenue > 0 ? (totalGrossProfit / totalRevenue) * 100 : 0,
      customerCount: customers.length,
      totalJobs: customers.reduce((a, c) => a + c.jobs.length, 0),
      fakeChampions: customers.filter((c) => c.isFakeChampion).length,
      tierBreakdown,
    },
  };
}

/* -------------------------------------------------------------- utilities */
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000);
}

/** the percentile: value at fraction p of a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function priorYearIso(iso: string): string {
  return addMonthsIso(iso, -12);
}

/* ------------------------------------------------------------------- main */
export async function customerData(
  period: { from: string; to: string; label: string },
  orgId: string,
  allowed: ReadonlySet<string> | null,
  strings: CustomerStrings = englishCustomerStrings,
): Promise<CustomerData> {
  const { moneyCompact } = await getMoneyFormatter(orgId)
  const { from, to } = period;
  const pFrom = priorYearIso(from);
  const pTo = priorYearIso(to);
  // Recency/overdue are measured "as of now", never a future period end.
  const today = await businessToday(orgId);
  const ref = to < today ? to : today;

  // Per-org tunable thresholds (defaults reproduce the standard scoring exactly).
  const cfg = await analyticsConfig(orgId, "customerIntelligence");
  // mergeConfig always materializes every default key for the dashboard.
  const churnCritical = cfg.churnCriticalScore!;
  const churnHigh = cfg.churnHighScore!;
  const churnMedium = cfg.churnMediumScore!;
  const hhiWarning = cfg.hhiWarning!;
  const hhiCritical = cfg.hhiCritical!;
  const clvYears = cfg.clvYears!;

  const [baseRows, frictionRows, paymentRows, growthRows, growthCounts, cohortRows, ledgerRows, growthLedgerRows, cohortLedgerRows, profitData, dsoStats] = await Promise.all([
    // Base customer metrics — the header query over CustInvc(+CashSale):
    // per-customer invoice count / INVOICED revenue / first-last dates /
    // recency / tenure. This is the billing-activity population the ledger
    // money (recognized + recon) merges onto; YoY context now reads prior
    // recognized revenue from the ledger legs, so no prior-year doc legs.
    // documents.total is transaction currency: the first leg translates at
    // the posted document rate to the posting subsidiary's functional; the
    // second leg to presentation runs per (party, functional) below.
    (db.execute(sql`
      select d.party_id as id, coalesce(p.display_name, 'Unknown') as name,
        sub.base_currency as func,
        count(*) as txn_count,
        sum(round(abs(d.total) * d.fx_rate, 4)) as revenue,
        max(d.posting_date)::text as late,
        min(d.posting_date) as first_txn,
        max(d.posting_date) as last_txn
      from documents d
      join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
        and d.voided_at is null and d.party_id is not null
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
        and d.posting_date >= ${from} and d.posting_date <= ${to}
      group by d.party_id, p.display_name, sub.base_currency
      having sum(abs(d.total)) > 0
    `)),
    // Friction — credit memos per customer (returns×3 + credits×2;
    // this ledger has no return-auth kind, so returns are always 0).
    // Credit value translates per (party, functional) below.
    (db.execute(sql`
      select d.party_id as id, sub.base_currency as func,
        count(*) filter (where d.kind = 'customer_credit') as credit_count,
        coalesce(sum(round(abs(d.total) * d.fx_rate, 4)) filter (where d.kind = 'customer_credit'), 0) as credit_value,
        max(d.posting_date) filter (where d.kind = 'customer_credit')::text as late,
        count(*) filter (where d.kind = 'customer_invoice') as order_count
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind in ('customer_credit', 'customer_invoice')
        and d.status = 'posted' and d.voided_at is null and d.party_id is not null
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
        and d.posting_date >= ${from} and d.posting_date <= ${to}
      group by d.party_id, sub.base_currency
      having count(*) filter (where d.kind = 'customer_invoice') > 0
    `)),
    // Payment behaviour — paid = fully-applied invoice; days-to-pay = final
    // application date − invoice date; overdue =
    // past due and not fully paid, as of the reference date.
    (db.execute(sql`
      with inv as (
        select d.id, d.party_id, d.posting_date, d.due_date, abs(d.total) as total,
          -- documents.total is denominated in the invoice transaction
          -- currency, so compare it with the transaction-currency leg of an
          -- application. applications.amount is the base-currency carrying
          -- amount and is not comparable for FX invoices.
          coalesce(sum(ap.target_transaction_amount), 0) as applied,
          max(pe.posting_date) as last_payment
        from documents d
        join journal_entries ie on ie.source_document_id = d.id and ie.org_id = d.org_id
          and ie.status in ('posted', 'reversed') and ie.book_id = ${statementBookExpr(orgId)}
        join journal_lines il on il.entry_id = ie.id and il.org_id = ie.org_id
        join accounts ia on ia.id = il.account_id and ia.org_id = il.org_id and ia.type = 'asset_receivable'
        left join applications ap on ap.to_line_id = il.id and ap.org_id = il.org_id and ap.unapplied_at is null
          and ap.applied_on <= ${ref}
          and exists (select 1 from journal_lines source_line
            join journal_entries source_entry on source_entry.id = source_line.entry_id and source_entry.org_id = source_line.org_id
            where source_line.id = ap.from_line_id and source_line.org_id = ap.org_id
              and source_entry.status in ('posted', 'reversed')
              and source_entry.book_id = ${statementBookExpr(orgId)}
              and source_entry.posting_date <= ${ref}
              ${subsidiaryVisibleFilter(sql`source_line.subsidiary_id`, allowed)})
        left join journal_lines pl on pl.id = ap.from_line_id and pl.org_id = ap.org_id
        left join journal_entries pe on pe.id = pl.entry_id and pe.org_id = pl.org_id
        where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
          ${subsidiaryVisibleFilter(sql`il.subsidiary_id`, allowed)}
          and d.voided_at is null and d.party_id is not null
          ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
          and d.posting_date >= ${from} and d.posting_date <= ${to}
        group by d.id, d.party_id, d.posting_date, d.due_date, d.total
      )
      select party_id as id,
        count(*) as invoice_count,
        count(*) filter (where applied >= total) as paid_count,
        avg(last_payment - posting_date) filter (where applied >= total) as avg_days_to_pay,
        count(*) filter (where due_date < ${ref} and applied < total) as overdue_count
      from inv
      group by party_id
    `)),
    // Growth trends — monthly revenue / unique customers / txns / NEW customers
    // (no earlier customer doc of any kind, lifetime — the NOT EXISTS).
    // A customer is new in the month it first appears. Asking that as a
    // correlated NOT EXISTS re-scanned the document history once per invoice
    // in the window; each party's first month is computed once instead, which
    // is the same test — the invoice itself qualifies, so "no earlier document"
    // and "first document is this month" coincide.
    (db.execute(sql`
      with first_doc as (
        select party_id, min(date_trunc('month', posting_date)) as first_month
          from documents
         where org_id = ${orgId} and kind in ('customer_invoice', 'sales_order')
           and voided_at is null and party_id is not null
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}
         group by party_id
      )
      select to_char(d.posting_date, 'YYYY-MM') as month,
        sub.base_currency as func,
        sum(round(abs(d.total) * d.fx_rate, 4)) as revenue,
        max(d.posting_date)::text as late
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
        and d.voided_at is null and d.party_id is not null
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
        and d.posting_date >= ${from} and d.posting_date <= ${to}
      group by 1, 2 order by 1
    `)),
    // Growth counts — distinct customers never merge across functionals, so
    // they stay on their own month grain while revenue translates above.
    (db.execute(sql`
      with first_doc as (
        select party_id, min(date_trunc('month', posting_date)) as first_month
          from documents
         where org_id = ${orgId} and kind in ('customer_invoice', 'sales_order')
           and voided_at is null and party_id is not null
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}
         group by party_id
      )
      select to_char(d.posting_date, 'YYYY-MM') as month,
        count(distinct d.party_id) as unique_customers,
        count(*) as txn_count,
        count(distinct d.party_id) filter (
          where f.first_month = date_trunc('month', d.posting_date)) as new_customers
      from documents d
      join first_doc f on f.party_id = d.party_id
      where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
        and d.voided_at is null and d.party_id is not null
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
        and d.posting_date >= ${from} and d.posting_date <= ${to}
      group by 1 order by 1
    `)),
    // Cohorts — lifetime per-customer first/last order + lifetime revenue;
    // grouped into join-year cohorts below (active = ordered in last 6 months).
    // Lifetime revenue translates per (party, functional) below.
    (db.execute(sql`
      select party_id as id, sub.base_currency as func,
        max(posting_date) as last_order, min(posting_date) as first_order,
        max(posting_date)::text as late,
        sum(round(abs(total) * fx_rate, 4)) as lifetime_revenue
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
        and d.voided_at is null and d.party_id is not null
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
      group by party_id, sub.base_currency
    `)),
    // Recognized revenue + recon legs, per (customer, functional) — the SAME
    // universe the P&L reads (REVENUE_TYPES legs on posted/reversed entries in
    // the statement book), cut per customer. Attribution is direct through the
    // line party (invoices, credit memos and party-tagged manuals all stamp
    // it — credit memos carry the same dims as the sale, so no unallocated
    // bucket) plus recognition schedules, whose legs carry no party and are
    // attributed through the contract customer instead. Amounts are stored
    // base (functional), translated to presentation per leg below — never
    // re-derived from document rates, so this cannot drift from the P&L.
    // Reversed entries and their mirrors stay IN (they net, exactly as the P&L
    // nets them); the recon separates their period effect into `voids`.
    (db.execute(sql`
      with ew as materialized (
        select id, posting_date, status, origin, source_document_id,
               (reverses_entry_id is not null or status = 'reversed') as is_void
          from journal_entries
         where org_id = ${orgId}
           and posting_date >= ${pFrom} and posting_date <= ${to}
           and status in ('posted', 'reversed')
           and book_id = ${statementBookExpr(orgId)}
      )
      select coalesce(l.party_id, rc.customer_id) as id,
        sub.base_currency as func,
        -sum(l.amount) filter (
          where a.type in ${REVENUE_TYPES} and e.posting_date >= ${from}) as recognized,
        -sum(l.amount) filter (
          where a.type in ${REVENUE_TYPES}
            and e.posting_date >= ${pFrom} and e.posting_date <= ${pTo}) as prior_recognized,
        sum(l.amount) filter (
          where a.type in ${REVENUE_TYPES} and not e.is_void and d.kind = 'customer_credit'
            and e.posting_date >= ${from}) as credits,
        -sum(l.amount) filter (
          where l.tax_code_id is not null and not e.is_void and d.kind = 'customer_invoice'
            and e.posting_date >= ${from}) as tax,
        sum(l.amount) filter (
          where a.type in ${REVENUE_TYPES} and not e.is_void and d.kind = 'customer_invoice'
            and e.posting_date >= ${from}) as inv_income,
        sum(l.amount) filter (
          where a.type <> 'asset_receivable' and l.tax_code_id is null
            and not e.is_void and d.kind = 'customer_invoice'
            and e.posting_date >= ${from}) as inv_nonar,
        -sum(l.amount) filter (
          where a.type in ${REVENUE_TYPES} and not e.is_void
            and e.origin = 'revenue_recognition'
            and e.posting_date >= ${from}) as sched,
        sum(l.amount) filter (
          where a.type in ${REVENUE_TYPES} and e.is_void
            and e.posting_date >= ${from}) as voids,
        max(e.posting_date) filter (where e.posting_date >= ${from})::text as late,
        max(e.posting_date) filter (
          where e.posting_date >= ${pFrom} and e.posting_date <= ${pTo})::text as late_prior
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = ${orgId}
      join accounts a on a.id = l.account_id and a.org_id = ${orgId}
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
      left join documents d on d.id = e.source_document_id and d.org_id = ${orgId}
      -- Schedules carry no party, so their legs attribute through the contract
      -- customer — including cancellation mirrors, which link back through
      -- reversal_journal_entry_id (f6's cancellation route flips the original to
      -- reversed and posts the mirror with reverses_entry_id, so both land in
      -- voids and net exactly like document voids).
      left join recognition_schedule_lines rsl
        on (rsl.journal_entry_id = e.id or rsl.reversal_journal_entry_id = e.id)
       and rsl.org_id = ${orgId}
       and e.origin = 'revenue_recognition'
      left join recognition_schedules rs on rs.id = rsl.schedule_id and rs.org_id = ${orgId}
      left join performance_obligations po on po.id = rs.obligation_id and po.org_id = ${orgId}
      left join revenue_contracts rc on rc.id = po.contract_id and rc.org_id = ${orgId}
      where (l.party_id is not null or rc.customer_id is not null)
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      group by 1, 2
    `)),
    // Recognized revenue per month (ledger posting month — recognition timing,
    // not billing month; the gap between this and the invoiced series IS the
    // timing story). Invoiced monthly stays on the document query above.
    (db.execute(sql`
      with ew as materialized (
        select id, posting_date, origin
          from journal_entries
         where org_id = ${orgId}
           and posting_date >= ${from} and posting_date <= ${to}
           and status in ('posted', 'reversed')
           and book_id = ${statementBookExpr(orgId)}
      )
      select to_char(e.posting_date, 'YYYY-MM') as month,
        sub.base_currency as func,
        -sum(l.amount) as recognized,
        max(e.posting_date)::text as late
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = ${orgId}
      join accounts a on a.id = l.account_id and a.org_id = ${orgId}
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
      -- Schedules carry no party, so their legs attribute through the contract
      -- customer — including cancellation mirrors, which link back through
      -- reversal_journal_entry_id (f6's cancellation route flips the original to
      -- reversed and posts the mirror with reverses_entry_id, so both land in
      -- voids and net exactly like document voids).
      left join recognition_schedule_lines rsl
        on (rsl.journal_entry_id = e.id or rsl.reversal_journal_entry_id = e.id)
       and rsl.org_id = ${orgId}
       and e.origin = 'revenue_recognition'
      left join recognition_schedules rs on rs.id = rsl.schedule_id and rs.org_id = ${orgId}
      left join performance_obligations po on po.id = rs.obligation_id and po.org_id = ${orgId}
      left join revenue_contracts rc on rc.id = po.contract_id and rc.org_id = ${orgId}
      where a.type in ${REVENUE_TYPES}
        and (l.party_id is not null or rc.customer_id is not null)
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      group by 1, 2 order by 1
    `)),
    // Lifetime recognized per customer, for cohorts (lifetime invoiced stays
    // on the document query above).
    (db.execute(sql`
      with ew as materialized (
        select id, posting_date, origin
          from journal_entries
         where org_id = ${orgId}
           and status in ('posted', 'reversed')
           and book_id = ${statementBookExpr(orgId)}
      )
      select coalesce(l.party_id, rc.customer_id) as id,
        sub.base_currency as func,
        -sum(l.amount) as recognized,
        max(e.posting_date)::text as late
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = ${orgId}
      join accounts a on a.id = l.account_id and a.org_id = ${orgId}
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
      -- Schedules carry no party, so their legs attribute through the contract
      -- customer — including cancellation mirrors, which link back through
      -- reversal_journal_entry_id (f6's cancellation route flips the original to
      -- reversed and posts the mirror with reverses_entry_id, so both land in
      -- voids and net exactly like document voids).
      left join recognition_schedule_lines rsl
        on (rsl.journal_entry_id = e.id or rsl.reversal_journal_entry_id = e.id)
       and rsl.org_id = ${orgId}
       and e.origin = 'revenue_recognition'
      left join recognition_schedules rs on rs.id = rsl.schedule_id and rs.org_id = ${orgId}
      left join performance_obligations po on po.id = rs.obligation_id and po.org_id = ${orgId}
      left join revenue_contracts rc on rc.id = po.contract_id and rc.org_id = ${orgId}
      where a.type in ${REVENUE_TYPES}
        and (l.party_id is not null or rc.customer_id is not null)
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      group by 1, 2
    `)),
    customerProfitability(period, orgId, allowed),
    // The header "Avg DSO" is the ONE org DSO — the same settlement-weighted
    // trailing mean the cash cockpit, cashflow analytics, MCP cashflow tool,
    // and get_vitals read — never a second per-customer grain computed here.
    paymentStats("ar", ref, allowed ? [...allowed] : undefined, orgId),
  ]);

  /* ---- recognized revenue + recon (ledger universe, per party) ---- */
  interface LedgerSqlRow {
    id: string;
    func: string | null;
    recognized: CustomerSqlNumeric;
    prior_recognized: CustomerSqlNumeric;
    credits: CustomerSqlNumeric;
    tax: CustomerSqlNumeric;
    inv_income: CustomerSqlNumeric;
    inv_nonar: CustomerSqlNumeric;
    sched: CustomerSqlNumeric;
    voids: CustomerSqlNumeric;
    late: string | null;
    late_prior: string | null;
  }
  interface LedgerParty {
    recognized: string; priorRecognized: string; credits: string; tax: string;
    parked: string; sched: string; voids: string;
  }
  // Legs arrive per (party, functional) in stored base amounts; translate each
  // to presentation at its latest posting date, then merge per party — the
  // same leg pattern the document measures use, so FX handling cannot diverge.
  const ledgerLegs = ledgerRows.rows as unknown as LedgerSqlRow[];
  const ledgerCtx = await flowRates(orgId, [
    ...ledgerLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
    ...ledgerLegs.filter((r) => r.prior_recognized != null)
      .map((r) => ({ func: r.func ?? null, date: String(r.late_prior ?? pTo).slice(0, 10) })),
  ]);
  const ledgerByParty = new Map<string, LedgerParty>();
  const zeroLedger = (): LedgerParty => ({
    recognized: "0", priorRecognized: "0", credits: "0", tax: "0",
    parked: "0", sched: "0", voids: "0",
  });
  for (const r of ledgerLegs) {
    const cur = ledgerByParty.get(r.id) ?? zeroLedger();
    const at = (v: CustomerSqlNumeric, d: string | null, fallback: string) =>
      mulDecimal(String(v ?? 0), ledgerCtx.rateAt(r.func ?? null, String(d ?? fallback).slice(0, 10)));
    cur.recognized = add(cur.recognized, at(r.recognized, r.late, to));
    if (r.prior_recognized != null) {
      cur.priorRecognized = add(cur.priorRecognized, at(r.prior_recognized, r.late_prior, pTo));
    }
    cur.credits = add(cur.credits, at(r.credits, r.late, to));
    cur.tax = add(cur.tax, at(r.tax, r.late, to));
    // Parked = invoice net routed to deferred liability: invoice income legs
    // minus every non-AR ex-tax leg on the same invoice entries (income +
    // deferred). Zero for a directly-earned invoice, the full net when parked.
    cur.parked = add(cur.parked, at(add(String(r.inv_income ?? 0), neg(String(r.inv_nonar ?? 0))), r.late, to));
    cur.sched = add(cur.sched, at(r.sched, r.late, to));
    cur.voids = add(cur.voids, at(r.voids, r.late, to));
    ledgerByParty.set(r.id, cur);
  }

  /* ---- base metrics ---- */
  interface Base {
    id: string; name: string; revenue: number; priorRevenue: number;
    invoicedRevenue: number; recon: CustomerRevenueRecon;
    txns: number; avgValue: number;
    first: string | null; last: string | null; recency: number; tenure: number;
  }
  // Invoiced revenue arrives per (party, functional) at the posted document
  // rate; translate each leg to presentation at its latest posting date, then
  // merge per party. Average = translated invoiced revenue per invoice.
  const baseLegs = baseRows.rows as unknown as CustomerBaseSqlRow[];
  const baseCtx = await flowRates(orgId, baseLegs.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? to).slice(0, 10),
  })));
  const baseByParty = new Map<string, { name: string; revenue: string; txns: number; first: string | null; last: string | null }>();
  for (const r of baseLegs) {
    const cur = baseByParty.get(r.id) ?? { name: String(r.name), revenue: "0", txns: 0, first: null as string | null, last: null as string | null };
    cur.revenue = add(cur.revenue, mulDecimal(String(r.revenue ?? 0), baseCtx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10))));
    cur.txns += Number(r.txn_count ?? 0);
    const first = r.first_txn ? String(r.first_txn).slice(0, 10) : null;
    const last = r.last_txn ? String(r.last_txn).slice(0, 10) : null;
    if (first && (!cur.first || first < cur.first)) cur.first = first;
    if (last && (!cur.last || last > cur.last)) cur.last = last;
    baseByParty.set(r.id, cur);
  }
  const base: Base[] = [...baseByParty.entries()].map(([id, c]) => {
    // Headline money is RECOGNIZED (ledger); invoiced stays alongside as the
    // reconciling column. Population, counts and dates stay document-based:
    // they describe billing activity, not earned value.
    const invoicedRevenue = Number(c.revenue);
    const led = ledgerByParty.get(id);
    const revenue = led ? Number(led.recognized) : 0;
    const tax = led ? Number(led.tax) : 0;
    const credits = led ? Number(led.credits) : 0;
    const timingDeferred = led ? Number(led.parked) : 0;
    const timingRecognized = led ? Number(led.sched) : 0;
    const voids = led ? Number(led.voids) : 0;
    const explained = tax + credits + (timingDeferred - timingRecognized) + voids;
    return {
      id,
      name: c.name,
      revenue,
      priorRevenue: led ? Number(led.priorRecognized) : 0,
      invoicedRevenue,
      recon: {
        tax,
        credits,
        timingDeferred,
        timingRecognized,
        voids,
        // Residual, not a plug target: manual-journal income with a party tag
        // and FX/rounding dust land here. The durable recon test pins it to
        // zero for pure document flows and to the manual amount when seeded.
        other: (invoicedRevenue - revenue) - explained,
      },
      txns: c.txns,
      // Billing behavior (average invoice size), not earned value — pairs with
      // invoice counts, which are document-based too.
      avgValue: c.txns > 0 ? invoicedRevenue / c.txns : 0,
      first: c.first,
      last: c.last,
      recency: c.last ? Math.max(0, daysBetween(c.last, ref)) : 9999,
      tenure: c.first && c.last ? daysBetween(c.first, c.last) : 0,
    };
  });

  /* ---- RFM () ---- */
  const freqSorted = base.map((c) => c.txns).sort((a, b) => a - b);
  const monSorted = base.map((c) => c.revenue).sort((a, b) => a - b);
  const freqP33 = percentile(freqSorted, 0.33);
  const freqP66 = percentile(freqSorted, 0.66);
  const monP33 = percentile(monSorted, 0.33);
  const monP66 = percentile(monSorted, 0.66);

  const rfmOf = (c: Base) => {
    let r = 1;
    if (c.recency <= RECENCY_GOOD) r = 5;
    else if (c.recency <= RECENCY_WARNING) r = 3;
    else if (c.recency <= RECENCY_CRITICAL) r = 2;
    let f = 1;
    if (c.txns > freqP66) f = 5;
    else if (c.txns > freqP33) f = 3;
    let m = 1;
    if (c.revenue > monP66) m = 5;
    else if (c.revenue > monP33) m = 3;

    let segment: Segment = "regular";
    if (r >= 4 && f >= 4 && m >= 4) segment = "champions";
    else if (r >= 3 && f >= 3 && m >= 4) segment = "loyal";
    else if (r >= 4 && f <= 2) segment = "new";
    else if (r >= 3 && m >= 3) segment = "potential";
    else if (r <= 2 && f >= 3 && m >= 3) segment = "hibernating";
    else if (r <= 2 && m <= 2) segment = "lost";
    else if (r <= 2 && f <= 2) segment = "at-risk";
    return { r, f, m, score: Math.round(((r + f + m) / 3) * 10) / 10, code: `${r}${f}${m}`, segment };
  };

  /* ---- CLV () ---- */
  const clvOf = (c: Base) => {
    const yearsActive = Math.max(0.25, c.tenure / 365);
    const freqPerYear = c.txns / yearsActive;
    const annualValue = c.avgValue * freqPerYear;
    const retention = Math.max(0.1, Math.min(0.95, 0.95 * Math.exp(-c.recency / 120)));
    return { annualValue: Math.round(annualValue), clv: Math.round(annualValue * clvYears * retention), retentionFactor: Math.round(retention * 100) };
  };

  /* ---- churn () ---- */
  const churnOf = (c: Base) => {
    let score = 0;
    const factors: string[] = [];
    if (c.recency > CHURN_HIGH_DAYS) { score += 40; factors.push(strings.churnInactive(c.recency)); }
    else if (c.recency > CHURN_MEDIUM_DAYS) { score += 25; factors.push(strings.churnDeclining); }
    else if (c.recency > 30) score += 10;
    const avgDaysBetween = c.tenure / Math.max(1, c.txns);
    if (c.recency > avgDaysBetween * 2) { score += 30; factors.push(strings.churnBelowPattern); }
    else if (c.recency > avgDaysBetween * 1.5) score += 15;
    if (c.txns <= 1) { score += 30; factors.push(strings.churnSingle); }
    else if (c.txns <= 3) { score += 15; factors.push(strings.churnLowFrequency); }
    score = Math.min(100, score);
    const level: RiskLevel = score >= churnCritical ? "critical" : score >= churnHigh ? "high" : score >= churnMedium ? "medium" : "low";
    return { score, level, factors, retentionProbability: Math.max(0, 100 - score), avgDaysBetween: Math.round(avgDaysBetween) };
  };

  /* ---- velocity () ---- */
  const velocityOf = (c: Base) => {
    const cycle = c.tenure > 0 && c.txns > 1 ? c.tenure / (c.txns - 1) : 30;
    const nextIn = Math.max(0, cycle - c.recency);
    const overdue = Math.max(0, c.recency - cycle);
    let urgency: CustomerRow["urgency"] = "on-track";
    if (overdue > cycle) urgency = "critical";
    else if (overdue > cycle * 0.5) urgency = "high";
    else if (overdue > 0) urgency = "medium";
    else if (nextIn <= 7) urgency = "due-soon";
    return { cycle: Math.round(cycle), overdue: Math.round(overdue), urgency, hasPattern: c.txns >= 2 };
  };

  /* ---- friction / payment lookups ---- */
  // Credit value arrives per (party, functional): translate each leg at its
  // latest posting date, then merge per party.
  const frictionLegs = frictionRows.rows as unknown as CustomerFrictionSqlRow[];
  const frictionCtx = await flowRates(orgId, frictionLegs.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? to).slice(0, 10),
  })));
  const frictionByParty = new Map<string, { credits: number; orders: number; creditValue: string }>();
  for (const r of frictionLegs) {
    const cur = frictionByParty.get(r.id) ?? { credits: 0, orders: 0, creditValue: "0" };
    cur.credits += Number(r.credit_count ?? 0);
    cur.orders += Number(r.order_count ?? 0);
    cur.creditValue = add(cur.creditValue, mulDecimal(String(r.credit_value ?? 0), frictionCtx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10))));
    frictionByParty.set(r.id, cur);
  }
  const frictionMap = new Map<string, { points: number; level: RiskLevel; credits: number; creditValue: number; returnRate: number }>();
  for (const [id, f] of frictionByParty) {
    const credits = f.credits;
    const orders = f.orders;
    const points = credits * 2; // returns×3 unavailable — no return-auth kind
    const returnRate = orders > 0 ? (credits / orders) * 100 : 0;
    let level: RiskLevel = "low";
    if (points >= 10 || returnRate >= 20) level = "critical";
    else if (points >= 5 || returnRate >= 10) level = "high";
    else if (points >= 2 || returnRate >= 5) level = "medium";
    if (points > 0) frictionMap.set(id, { points, level, credits, creditValue: Math.round(Number(f.creditValue)), returnRate: Math.round(returnRate * 10) / 10 });
  }

  const paymentMap = new Map<string, { score: number; rating: CustomerRow["paymentRating"]; avgDays: number | null; overdue: number; rate: number }>();
  let totInvoices = 0, totPaid = 0, totOverdue = 0;
  for (const r of paymentRows.rows as unknown as CustomerPaymentSqlRow[]) {
    const invoices = Number(r.invoice_count ?? 0);
    const paid = Number(r.paid_count ?? 0);
    const overdue = Number(r.overdue_count ?? 0);
    const avgDays = r.avg_days_to_pay === null ? null : Number(r.avg_days_to_pay);
    totInvoices += invoices; totPaid += paid; totOverdue += overdue;
    let score = 100;
    const d = avgDays ?? 0;
    if (d > 60) score -= 40;
    else if (d > 30) score -= 20;
    else if (d > 15) score -= 10;
    if (overdue > 0) score -= Math.min(40, overdue * 10);
    score = Math.max(0, score);
    const rating: CustomerRow["paymentRating"] = score < 40 ? "poor" : score < 60 ? "fair" : score < 80 ? "good" : "excellent";
    paymentMap.set(r.id, { score, rating, avgDays: avgDays === null ? null : Math.round(d), overdue, rate: invoices > 0 ? Math.round((paid / invoices) * 100) : 0 });
  }
  const paymentRate = totInvoices > 0 ? Math.round((totPaid / totInvoices) * 100) : 0;
  // Per-customer rows keep their own days-to-pay (drill detail); the header
  // KPI is the engine DSO so every surface quotes one number.
  const avgDaysToPay = dsoStats.globalAvg;

  const profitMap = new Map(profitData.customers.map((c) => [c.customerId, c]));

  /* ---- assemble per-customer, CLV tiers by rank ---- */
  const enriched = base.map((c) => {
    const rfm = rfmOf(c);
    const clv = clvOf(c);
    const churn = churnOf(c);
    const vel = velocityOf(c);
    return { c, rfm, clv, churn, vel };
  });
  // Tier assignment ranks by projected CLV.
  const byClv = [...enriched].sort((a, b) => b.clv.clv - a.clv.clv);
  const nAll = byClv.length;
  const platinumCutoff = Math.ceil(nAll * 0.1);
  const goldCutoff = Math.ceil(nAll * 0.3);
  const silverCutoff = Math.ceil(nAll * 0.6);
  const tierByCustomer = new Map<string, { tier: Tier; rank: number }>();
  byClv.forEach((e, i) => {
    const tier: Tier = i < platinumCutoff ? "platinum" : i < goldCutoff ? "gold" : i < silverCutoff ? "silver" : "bronze";
    tierByCustomer.set(e.c.id, { tier, rank: i + 1 });
  });
  const tierThresholds: Record<Tier, number> = {
    platinum: byClv[platinumCutoff - 1]?.clv.clv ?? 0,
    gold: byClv[goldCutoff - 1]?.clv.clv ?? 0,
    silver: byClv[silverCutoff - 1]?.clv.clv ?? 0,
    bronze: 0,
  };

  /* ---- concentration () ---- */
  const totalRevenue = base.reduce((a, c) => a + c.revenue, 0);
  const byRevenue = [...enriched].sort((a, b) => b.c.revenue - a.c.revenue);
  const shareMap = new Map<string, { sharePct: number; risk: RiskLevel }>();
  let cumulative = 0;
  let customersFor80Pct = 0;
  byRevenue.forEach((e, i) => {
    const sharePct = totalRevenue > 0 ? (e.c.revenue / totalRevenue) * 100 : 0;
    cumulative += sharePct;
    if (cumulative <= 80) customersFor80Pct = i + 1;
    const risk: RiskLevel = sharePct >= 25 ? "critical" : sharePct >= 15 ? "high" : sharePct >= 10 ? "medium" : "low";
    shareMap.set(e.c.id, { sharePct: Math.round(sharePct * 100) / 100, risk });
  });
  const hhiScaled = Math.round(byRevenue.reduce((a, e) => a + ((totalRevenue > 0 ? e.c.revenue / totalRevenue : 0) * 100) ** 2, 0));
  const hhiLevel: CustomerData["kpis"]["hhiLevel"] = hhiScaled >= hhiCritical ? "high" : hhiScaled >= hhiWarning ? "moderate" : "low";
  const top10PctCount = Math.ceil(nAll * 0.1);
  const top10Share = totalRevenue > 0 ? (byRevenue.slice(0, top10PctCount).reduce((a, e) => a + e.c.revenue, 0) / totalRevenue) * 100 : 0;

  /* ---- health scores + recommendations () ---- */
  const rows: CustomerRow[] = enriched.map(({ c, rfm, clv, churn, vel }) => {
    const friction = frictionMap.get(c.id);
    const payment = paymentMap.get(c.id);
    const profit = profitMap.get(c.id);
    const share = shareMap.get(c.id)!;
    const tierInfo = tierByCustomer.get(c.id)!;

    const recencyScore = rfm.r * 20;
    const frequencyScore = rfm.f * 20;
    const monetaryScore = rfm.m * 20;
    const paymentScore = payment ? payment.score : 75; // Default when unknown
    const frictionPenalty = friction?.level === "critical" ? 25 : friction?.level === "high" ? 15 : friction?.level === "medium" ? 8 : 0;

    let healthScore = Math.round(recencyScore * W_RECENCY + frequencyScore * W_FREQUENCY + monetaryScore * W_MONETARY + paymentScore * W_PAYMENT);
    healthScore = Math.max(0, healthScore - frictionPenalty);
    const healthGrade: CustomerRow["healthGrade"] =
      healthScore >= 90 ? "A+" : healthScore >= 80 ? "A" : healthScore >= 70 ? "B" : healthScore >= 60 ? "C" : healthScore >= 50 ? "D" : "F";

    // 7-priority recommendation ladder, verbatim.
    let recommendation: Recommendation = "maintain";
    let detail = strings.recMaintain;
    const velOverdue = vel.hasPattern ? vel.overdue : 0;
    if (friction && (friction.level === "critical" || friction.level === "high")) {
      recommendation = "resolve-issues";
      detail = strings.recFriction(friction.credits);
    } else if (vel.hasPattern && vel.urgency === "critical") {
      recommendation = "reactivate";
      detail = strings.recOverdue(vel.overdue, vel.cycle);
    } else if (churn.level === "critical" || churn.level === "high") {
      recommendation = "win-back";
      detail = strings.recWinBack;
    } else if (healthScore >= 85 && clv.clv > 10_000) {
      recommendation = "nurture";
      detail = strings.recNurture;
    } else if (rfm.segment === "new") {
      recommendation = "onboard";
      detail = strings.recOnboard;
    } else if (profit?.isFakeChampion) {
      recommendation = "reprice";
      detail = strings.recReprice(profit.marginPct.toFixed(1));
    } else if (healthScore < 50) {
      recommendation = "review";
      detail = strings.recReview;
    }

    return {
      id: c.id,
      name: strings.displayCustomerName(c.name),
      revenue: c.revenue,
      priorRevenue: c.priorRevenue,
      invoicedRevenue: c.invoicedRevenue,
      recon: c.recon,
      yoyPct: c.priorRevenue > 0 ? (c.revenue - c.priorRevenue) / c.priorRevenue : null,
      invoices: c.txns,
      avgInvoice: c.avgValue,
      firstInvoice: c.first,
      lastInvoice: c.last,
      recencyDays: c.recency,
      tenureDays: c.tenure,
      rfm: { r: rfm.r, f: rfm.f, m: rfm.m, score: rfm.score, code: rfm.code },
      segment: rfm.segment,
      annualValue: clv.annualValue,
      clv: clv.clv,
      retentionFactor: clv.retentionFactor,
      tier: tierInfo.tier,
      clvRank: tierInfo.rank,
      churnScore: churn.score,
      churnLevel: churn.level,
      churnFactors: churn.factors,
      retentionProbability: churn.retentionProbability,
      avgDaysBetween: churn.avgDaysBetween,
      frictionPoints: friction?.points ?? 0,
      frictionLevel: friction?.level ?? "low",
      creditCount: friction?.credits ?? 0,
      creditValue: friction?.creditValue ?? 0,
      returnRate: friction?.returnRate ?? 0,
      avgOrderCycle: vel.hasPattern ? vel.cycle : 0,
      daysOverdue: velOverdue,
      urgency: vel.hasPattern ? vel.urgency : "on-track",
      paymentScore,
      paymentRating: payment?.rating ?? "unknown",
      avgDaysToPay: payment?.avgDays ?? null,
      overdueCount: payment?.overdue ?? 0,
      paymentRate: payment ? payment.rate : null,
      sharePct: share.sharePct,
      concentrationRisk: share.risk,
      grossProfit: profit ? profit.grossProfit : null,
      marginPct: profit ? profit.marginPct : null,
      isFakeChampion: profit?.isFakeChampion ?? false,
      jobs: profit?.jobs.length ?? 0,
      healthScore,
      healthGrade,
      recommendation,
      recommendationDetail: detail,
      scoreBreakdown: { recency: recencyScore, frequency: frequencyScore, monetary: monetaryScore, payment: paymentScore, frictionPenalty: -frictionPenalty },
    };
  });
  rows.sort((a, b) => b.healthScore - a.healthScore);

  /* ---- segments distribution ---- */
  const SEGMENTS: Segment[] = ["champions", "loyal", "potential", "new", "regular", "hibernating", "at-risk", "lost"];
  const segments: SegmentStat[] = SEGMENTS.map((segment) => {
    const set = rows.filter((r) => r.segment === segment);
    const rev = set.reduce((a, r) => a + r.revenue, 0);
    return {
      segment,
      count: set.length,
      percentage: rows.length ? Math.round((set.length / rows.length) * 100) : 0,
      totalRevenue: rev,
      avgRevenue: set.length ? rev / set.length : 0,
      totalInvoiced: set.reduce((a, r) => a + r.invoicedRevenue, 0),
    };
  });

  /* ---- growth () ---- */
  // Monthly INVOICED revenue arrives per (month, functional): translate each leg
  // at its latest posting date, then merge per month. Distinct counts ride the
  // separate month-grain query (they never merge across functionals). The
  // recognized monthly series is built from the ledger legs just below.
  const gLegs = growthRows.rows as unknown as CustomerGrowthSqlRow[];
  const gCtx = await flowRates(orgId, gLegs.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? `${r.month}-01`).slice(0, 10),
  })));
  const gRevenue = new Map<string, string>();
  for (const r of gLegs) {
    const key = String(r.month);
    gRevenue.set(key, add(gRevenue.get(key) ?? "0",
      mulDecimal(String(r.revenue ?? 0), gCtx.rateAt(r.func ?? null, String(r.late ?? `${r.month}-01`).slice(0, 10)))));
  }
  interface GrowthCountRow { month: string; unique_customers: CustomerSqlNumeric; txn_count: CustomerSqlNumeric; new_customers: CustomerSqlNumeric }
  const gCounts = new Map<string, GrowthCountRow>();
  for (const r of growthCounts.rows as unknown as GrowthCountRow[]) {
    gCounts.set(String(r.month), r);
  }
  // Recognized monthly: same leg pattern over the ledger month query. Months
  // present in only one universe still appear (the other reads zero) so the
  // timing gap between billing and recognition stays visible month by month.
  interface GrowthLedgerRow { month: string; func: string | null; recognized: CustomerSqlNumeric; late: string | null }
  const glLegs = growthLedgerRows.rows as unknown as GrowthLedgerRow[];
  const glCtx = await flowRates(orgId, glLegs.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? `${r.month}-01`).slice(0, 10),
  })));
  const gRecognized = new Map<string, string>();
  for (const r of glLegs) {
    const key = String(r.month);
    gRecognized.set(key, add(gRecognized.get(key) ?? "0",
      mulDecimal(String(r.recognized ?? 0), glCtx.rateAt(r.func ?? null, String(r.late ?? `${r.month}-01`).slice(0, 10)))));
  }
  const gInvoiced = gRevenue;
  const gRows = [...new Set([...gInvoiced.keys(), ...gRecognized.keys(), ...gCounts.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .map((month) => ({
      month,
      invoiced: gInvoiced.get(month) ?? "0",
      revenue: gRecognized.get(month) ?? "0",
      counts: gCounts.get(month),
    }));
  const revenues = gRows.map((r) => Number(r.revenue)).sort((a, b) => a - b);
  const medianRevenue = revenues.length ? revenues[Math.floor(revenues.length / 2)]! : 0;
  const minRevenueThreshold = medianRevenue * 0.1;
  let prevRevenue: number | null = null;
  const monthly: MonthlyGrowth[] = gRows.map((r) => {
    const revenue = Number(r.revenue);
    const isMature = revenue >= minRevenueThreshold;
    let growthRate: number | null = 0;
    if (prevRevenue !== null && prevRevenue > minRevenueThreshold) {
      growthRate = ((revenue - prevRevenue) / prevRevenue) * 100;
      if (growthRate > 200) growthRate = 200;
      if (growthRate < -80) growthRate = -80;
      growthRate = Math.round(growthRate * 10) / 10;
    } else if (prevRevenue !== null && prevRevenue > 0 && revenue > minRevenueThreshold) {
      growthRate = null; // ramp-up period
    }
    prevRevenue = revenue;
    return {
      month: r.month,
      label: strings.monthLabel(r.month),
      revenue: Math.round(revenue),
      invoiced: Math.round(Number(r.invoiced)),
      uniqueCustomers: Number(r.counts?.unique_customers ?? 0),
      transactionCount: Number(r.counts?.txn_count ?? 0),
      newCustomers: Number(r.counts?.new_customers ?? 0),
      growthRate,
      isMature,
    };
  });
  let yoyGrowth: number | null = null;
  if (monthly.length >= 15) {
    const recent3 = monthly.slice(-3).reduce((a, m) => a + m.revenue, 0);
    const prior3 = monthly.slice(-15, -12).reduce((a, m) => a + m.revenue, 0);
    if (prior3 > minRevenueThreshold) yoyGrowth = Math.round(((recent3 - prior3) / prior3) * 100);
  }
  const matureGrowthRates = monthly.filter((m) => m.isMature && m.growthRate !== null).map((m) => m.growthRate!) ;
  const avgMonthlyGrowth = matureGrowthRates.length ? Math.round((matureGrowthRates.reduce((a, r) => a + r, 0) / matureGrowthRates.length) * 10) / 10 : 0;
  let trend: CustomerData["growth"]["trend"] = "stable";
  if (monthly.length >= 6) {
    // Compare equal-length, adjacent windows. With less than twelve months of
    // history, use the largest pair available (three to five months each)
    // rather than reusing months in both windows and damping the signal.
    const windowSize = Math.min(6, Math.floor(monthly.length / 2));
    const recentWindow = monthly.slice(-windowSize);
    const priorWindow = monthly.slice(-windowSize * 2, -windowSize);
    const recentAverage = recentWindow.reduce((a, m) => a + m.revenue, 0) / windowSize;
    const priorAverage = priorWindow.reduce((a, m) => a + m.revenue, 0) / windowSize;
    const pct = priorAverage > 0 ? ((recentAverage - priorAverage) / priorAverage) * 100 : 0;
    if (pct > 10) trend = "growing";
    else if (pct < -10) trend = "declining";
  }
  const totalNewCustomers = monthly.reduce((a, m) => a + m.newCustomers, 0);

  /* ---- cohorts () ---- */
  const sixMonthsAgo = new Date(ref + "T00:00:00Z");
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const activeCut = sixMonthsAgo.toISOString().slice(0, 10);
  // Lifetime INVOICED revenue arrives per (party, functional): translate each leg
  // at its latest posting date, merge per party, then run the cohort logic on
  // parties (never on legs). Lifetime recognized merges in from the ledger
  // legs just below; cohort membership (first/last year) stays document-based.
  interface CohortLeg { id: string; func: string | null; first_order: unknown; last_order: unknown; late: string | null; lifetime_revenue: CustomerSqlNumeric }
  const cohortLegs = cohortRows.rows as unknown as CohortLeg[];
  const cohortCtx = await flowRates(orgId, cohortLegs.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? to).slice(0, 10),
  })));
  const cohortByParty = new Map<string, { first: string; last: string; revenue: string; invoiced: string }>();
  for (const r of cohortLegs) {
    const first = String(r.first_order).slice(0, 10);
    const last = String(r.last_order).slice(0, 10);
    const cur = cohortByParty.get(r.id) ?? { first, last, revenue: "0", invoiced: "0" };
    if (first < cur.first) cur.first = first;
    if (last > cur.last) cur.last = last;
    cur.invoiced = add(cur.invoiced, mulDecimal(String(r.lifetime_revenue ?? 0),
      cohortCtx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10))));
    cohortByParty.set(r.id, cur);
  }
  interface CohortLedgerLeg { id: string; func: string | null; recognized: CustomerSqlNumeric; late: string | null }
  const cohortLedgerLegs = cohortLedgerRows.rows as unknown as CohortLedgerLeg[];
  const cohortLedgerCtx = await flowRates(orgId, cohortLedgerLegs.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? to).slice(0, 10),
  })));
  for (const r of cohortLedgerLegs) {
    const cur = cohortByParty.get(r.id);
    // Recognition without any invoice history has no cohort to join (cohorts
    // are billing relationships by first-order year) — the org-level P&L tie
    // still counts it, so no money is lost, only uncohortable.
    if (!cur) continue;
    cur.revenue = add(cur.revenue, mulDecimal(String(r.recognized ?? 0),
      cohortLedgerCtx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10))));
  }
  const cohortMap = new Map<string, Cohort>();
  let lifetimeCustomers = 0, lifetimeActive = 0;
  for (const p of cohortByParty.values()) {
    const year = p.first.slice(0, 4);
    const isActive = p.last >= activeCut;
    lifetimeCustomers++;
    if (isActive) lifetimeActive++;
    let c = cohortMap.get(year);
    if (!c) { c = { year, totalCustomers: 0, activeCustomers: 0, retentionRate: 0, totalRevenue: 0, avgRevenue: 0, totalInvoiced: 0 }; cohortMap.set(year, c); }
    c.totalCustomers++;
    if (isActive) c.activeCustomers++;
    c.totalRevenue += Number(p.revenue);
    c.totalInvoiced += Number(p.invoiced);
  }
  const cohortList = [...cohortMap.values()]
    .map((c) => ({
      ...c,
      retentionRate: c.totalCustomers ? Math.round((c.activeCustomers / c.totalCustomers) * 100) : 0,
      avgRevenue: c.totalCustomers ? Math.round(c.totalRevenue / c.totalCustomers) : 0,
      totalRevenue: Math.round(c.totalRevenue),
      totalInvoiced: Math.round(c.totalInvoiced),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));
  const overallRetention = lifetimeCustomers ? Math.round((lifetimeActive / lifetimeCustomers) * 100) : 0;

  /* ---- intelligence score () ---- */
  const championsStat = segments.find((s) => s.segment === "champions")!;
  const championsScore = Math.min(100, championsStat.percentage * 5);
  const avgRetentionProbability = rows.length ? Math.round(rows.reduce((a, r) => a + r.retentionProbability, 0) / rows.length) : 50;
  const concentrationHealth = hhiLevel === "high" ? 30 : hhiLevel === "moderate" ? 60 : 90;
  const intelligenceScore = Math.round(championsScore * 0.3 + avgRetentionProbability * 0.3 + concentrationHealth * 0.2 + paymentRate * 0.2);
  const { label: scoreLabel, grade: scoreGrade } = strings.intelligenceScore(intelligenceScore);

  /* ---- aggregates + insights ---- */
  const atRisk = rows.filter((r) => r.churnLevel === "critical" || r.churnLevel === "high");
  const atRiskRevenue = Math.round(atRisk.reduce((a, r) => a + r.revenue, 0));
  const totalProjectedClv = rows.reduce((a, r) => a + r.clv, 0);
  const overdueOrders = rows.filter((r) => r.daysOverdue > 0).length;
  const topCustomerShare = byRevenue[0] ? shareMap.get(byRevenue[0].c.id)!.sharePct : 0;

  const insights: Insight[] = [];
  const fmtM = (n: number) => moneyCompact(n);
  if (totalProjectedClv > 0)
    insights.push({ type: "info", category: "lifetime-value", ...strings.projectedClv(fmtM(totalProjectedClv), clvYears, rows.length), impact: "high" });
  if (atRisk.length > 0)
    insights.push({ type: "warning", category: "churn", ...strings.churnRisk(atRisk.length, fmtM(atRiskRevenue)), impact: "high" });
  if (championsStat.count > 0)
    insights.push({ type: "success", category: "segmentation", ...strings.champions(championsStat.count, fmtM(championsStat.totalRevenue)), impact: "high" });
  if (hhiLevel === "high")
    insights.push({ type: "alert", category: "concentration", ...strings.concentration(topCustomerShare.toFixed(1), hhiScaled), impact: "high" });
  if (trend === "declining")
    insights.push({ type: "warning", category: "growth", ...strings.declining(avgMonthlyGrowth), impact: "high" });
  else if (trend === "growing")
    insights.push({ type: "success", category: "growth", ...strings.growing(avgMonthlyGrowth, totalNewCustomers), impact: "medium" });
  if (totOverdue > 5)
    insights.push({ type: "warning", category: "payments", ...strings.overdue(totOverdue), impact: "medium" });

  const TIERS: Tier[] = ["platinum", "gold", "silver", "bronze"];
  return {
    period,
    rows,
    intelligence: { score: intelligenceScore, label: scoreLabel, grade: scoreGrade },
    kpis: {
      totalCustomers: rows.length,
      totalRevenue: Math.round(totalRevenue),
      totalInvoiced: Math.round(rows.reduce((a, r) => a + r.invoicedRevenue, 0)),
      avgCustomerValue: Math.round(totalRevenue / Math.max(1, rows.length)),
      projectedClv: Math.round(totalProjectedClv),
      avgClv: rows.length ? Math.round(totalProjectedClv / rows.length) : 0,
      champions: championsStat.count,
      atRiskCount: atRisk.length,
      atRiskRevenue,
      retentionRate: avgRetentionProbability,
      paymentRate,
      avgDaysToPay,
      top10PctShare: Math.round(top10Share),
      hhiScaled,
      hhiLevel,
      customersFor80Pct,
      topCustomerShare,
      monthlyGrowth: avgMonthlyGrowth,
      yoyGrowth,
      newCustomers: totalNewCustomers,
      overdueInvoices: totOverdue,
      overdueOrders,
      criticalFriction: rows.filter((r) => r.frictionLevel === "critical").length,
      highFriction: rows.filter((r) => r.frictionLevel === "high").length,
      fakeChampions: profitData.summary.fakeChampions,
    },
    segments,
    tierBreakdown: TIERS.map((tier) => {
      const set = rows.filter((r) => r.tier === tier);
      return { tier, count: set.length, revenue: set.reduce((a, r) => a + r.revenue, 0), invoiced: set.reduce((a, r) => a + r.invoicedRevenue, 0), threshold: tierThresholds[tier] };
    }),
    growth: { monthly, yoyGrowth, avgMonthlyGrowth, medianMonthlyRevenue: Math.round(medianRevenue), totalNewCustomers, trend },
    cohorts: { list: cohortList, overallRetention },
    insights,
    config: { churnCriticalScore: churnCritical, churnHighScore: churnHigh, churnMediumScore: churnMedium, hhiWarning, hhiCritical, clvYears },
  };
}
