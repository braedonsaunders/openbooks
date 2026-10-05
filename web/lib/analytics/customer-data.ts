import "server-only";
import { analyticsQuery } from "./query";
import { analyticsSection } from "./read-context";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { statementBookExpr } from "../gl-summary";
import { REVENUE_TYPES } from "../reports/statements";
import { getMoneyFormatter } from '../money-server'
import { sql } from "drizzle-orm";
import { addMonthsClamped, businessToday, calendarDaysBetween } from "@openbooks/engine/src/platform/business-date.ts";
import { db } from "@openbooks/engine/platform/database";
import { ANALYTICS_CONFIG, analyticsConfig } from "./config";
import { checkSumsTo, type ConfigValuesOf } from "./config-spec";
import { customerStrings, type CustomerStrings } from "./customer-strings";
import { englishCatalogMessage } from "./catalog-strings";
import { paymentStats } from "../cash/core";
import { isFeatureEnabled } from "../features";
import { flowRates } from "../fx-presentation";
import { add, cmp, div, mulDecimal, neg, sum } from "@openbooks/engine/src/money/money.ts";
import { exactMarginPercent, exactProfit } from "./customer-profitability-money";
import { evaluateAnalyticsRatio } from "./analytics-ratio";
import { PNL_COST_TYPES, PNL_TYPES } from "../account-types";

/**
 * Customer Intelligence — the data behind /analytics/customer-intelligence.
 * Every subsystem and its exact parameters:
 *  - Money (TWO measures, one definition each):
 *     * revenue = RECOGNIZED (ASC 606): net income-account postings per
 *       customer — the same legs the P&L resolver reads (REVENUE_TYPES,
 *       statement book, posted/reversed entries), net of credit memos, voids
 *       netting to zero. Attribution is line party_id plus recognition
 *       schedules through their contract customer (those legs carry no
 *       party). Single-functional reads tie leg-for-leg (the durable recon
 *       test pins it); multi-functional orgs translate each posting at its
 *       own document-date spot — the native P&L readers refuse
 *       multi-currency reads and the consolidated matrix uses per-period
 *       average rates, so the two can differ by rate timing there.
 *     * invoicedRevenue = BILLINGS: customer-invoice document totals at the
 *       document rate, with a void recorded as a negative movement on its
 *       reversal date — gross of credits, includes sales tax, blind to
 *       deferral. The reconciling column, never the headline.
 *     * recon bridges them per customer: invoiced − recognized =
 *       tax + credits + (timingDeferred − timingRecognized) + voids + other.
 *     Recognition cancellations attribute through the schedule
 *     reversal_journal_entry_id back-link. Document voids stay in the period
 *     where they were posted and reverse in the period their void is dated.
 *    Population, invoice counts, avg invoice value and first/last dates stay
 *    document-based (billing activity); every `revenue` roll-up (rows, KPIs,
 *    segments, tiers, monthly trend, cohorts) is recognized.
 *  - Base metrics: per-customer invoice count / invoiced + recognized revenue /
 *    avg invoice value / first-last dates / recency / tenure.
 *  - RFM: R from configured day bands; F/M from 33rd/66th percentile cuts
 *    ({1,3,5} scores); 8 behavioural segments
 *    (champions/loyal/new/potential/hibernating/lost/at-risk/regular).
 *  - CLV: annual value = invoiced ÷ annualized tenure (floor configured);
 *    retention = clamp(base·e^(−daysSinceLast/decay), min–max); projected CLV =
 *    annual × clvYears × retention; configured percentile tiers.
 *  - Churn: composite 0–100 from configured inactivity points, cadence
 *    multiples and engagement bands; levels from the configured churn cut-offs,
 *    retention probability = 100 − score.
 *  - Friction: credits×points-per-credit (+returns×3 — no return-auth kind in
 *    this ledger, so returns are always 0, stated in the UI); configured
 *    point and issue-rate bands.
 *  - Velocity: avg days between orders (tenure/(txns−1)); overdue vs cadence;
 *    urgency critical >1× / high >0.5× / medium >0 / due-soon ≤7d.
 *  - Payment: paid = fully-applied invoices; days-to-pay = final application
 *    date − invoice date (the closedate−trandate); score 100 minus the
 *    configured DSO-band and overdue penalties; configured ratings.
 *  - Growth: monthly revenue/customers/new-customers with median-based mature
 *    months (configured floor), capped MoM, YoY = last-3mo vs the matching
 *    window a year back, trend = recent-6 vs prior-6 in a configured band.
 *  - Cohorts: lifetime by first-order year; active = ordered in last 6 months.
 *  - Health: RFM sub-scores weighted by the configured health weights minus
 *    the configured friction penalty; a missing payment term drops out and
 *    the rest re-normalise. Graded on the shared A+/A/B/C/D/F ladder.
 *  - Intelligence score: champions share, average retention, concentration
 *    health and payment rate weighted by the configured intelligence
 *    weights, with missing terms dropped. Same shared ladder.
 */

/* --------------------------------------------------------------- constants */
// The scoring model lives in ANALYTICS_CONFIG.customerIntelligence: every
// weight, band and cut-off below is read from the effective org config at
// load time, so the Configuration tab edits the live model. The one value
// that stays a constant is the calendar year used to annualize tenure — a
// unit conversion, not an organization policy.
const DAYS_PER_YEAR = 365;

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
  /**
   * Exact decimal strings in presentation currency. The bridge identity is
   * money arithmetic (invoiced − recognized = tax + credits +
   * (timingDeferred − timingRecognized) + voids + other) and stays in
   * strings: float subtraction on ledger amounts leaves dust in `other`.
   */
  /** Sales tax inside invoiced document totals: collected-tax postings on
   *  invoice-sourced, non-reversed entries. Credit-memo tax relief is in NO
   *  row — it touches neither invoiced nor recognized — and reversed entries
   *  ride with voids. */
  tax: string;
  /** Credit memos: income-leg relief (debit postings to income accounts) on
   *  credit-sourced, non-reversed entries. The sales-tax relief on those same
   *  memos is deliberately NOT here — it touches neither invoiced nor
   *  recognized, so including it would break the bridge identity. */
  credits: string;
  /** Billed but not yet earned: invoice net routed to a deferred-liability
   *  account instead of income this period (ASC 606 timing). */
  timingDeferred: string;
  /** Earned but not billed this period: revenue-recognition schedule postings
   *  attributed through the contract customer (those legs carry no party_id). */
  timingRecognized: string;
  /** Income effect of reversals that have no corresponding document billing
   *  movement in the same period. */
  voids: string;
  /** Residual: manual-journal income with a party tag and FX/rounding dust —
   *  anything outside the buckets above. Persistently large `other` for a
   *  customer means a posting path the recon does not model yet. */
  other: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  // base metrics
  /**
   * RECOGNIZED revenue (ASC 606): net income-account postings attributed to
   * this customer in the period — the same legs the P&L resolver reads
   * (REVENUE_TYPES, statement book, posted/reversed entries), net of credit
   * memos. Compare with `invoicedRevenue`; the `recon` bridge explains the gap.
   */
  /** Exact decimal string in presentation currency. */
  revenue: string;
  /** Prior-period recognized revenue (YoY base for `revenue`). */
  priorRevenue: string;
  /**
   * INVOICED revenue (billings): customer-invoice document totals translated
   * at the document rate, with voids recorded in their reversal period. Gross
   * of credits, includes sales tax, blind to deferred recognition — the
   * cash/AR/sales-comp question, kept as the explicitly labelled reconciling
   * column, never the headline.
   */
  invoicedRevenue: string;
  /** The invoiced→recognized bridge; see CustomerRevenueRecon. */
  recon: CustomerRevenueRecon;
  yoyPct: number | null;
  invoices: number;
  /** Exact decimal string: translated invoiced revenue per invoice. */
  avgInvoice: string;
  firstInvoice: string | null;
  lastInvoice: string | null;
  /** Days since last order, null when the customer has no dated activity. */
  recencyDays: number | null;
  tenureDays: number;
  // RFM
  rfm: { r: number; f: number; m: number; score: number; code: string };
  segment: Segment;
  // CLV
  /** Exact decimal strings in presentation currency (statistical projection). */
  annualValue: string;
  clv: string; // projected
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
  creditValue: string;
  returnRate: number;
  // velocity
  avgOrderCycle: number;
  daysOverdue: number;
  urgency: "critical" | "high" | "medium" | "due-soon" | "on-track";
  // payment
  /** Null when the customer has no payment history: no term is scored. */
  paymentScore: number | null;
  paymentRating: "excellent" | "good" | "fair" | "poor" | "unknown";
  avgDaysToPay: number | null;
  overdueCount: number;
  paymentRate: number | null;
  // concentration
  sharePct: number; // 0–100
  concentrationRisk: RiskLevel;
  // profitability merge
  grossProfit: string | null;
  marginPct: number | null; // percentage points
  isFakeChampion: boolean;
  jobs: number;
  // health
  /** Null when no term was left to score: renders an em dash, never a 0 that grades as F. */
  healthScore: number | null;
  healthGrade: "A+" | "A" | "B" | "C" | "D" | "F" | null;
  recommendation: Recommendation;
  recommendationDetail: string;
  /** True when the customer has no payment history: the payment term was dropped. */
  scoredWithoutPayment: boolean;
  scoreBreakdown: { recency: number; frequency: number; monetary: number; payment: number | null; frictionPenalty: number };
}

export interface SegmentStat {
  segment: Segment;
  count: number;
  percentage: number;
  /** Recognized revenue in the period (ledger, net of credit memos). */
  totalRevenue: string;
  avgRevenue: string;
  /** Invoiced revenue in the period (billings, reconciling column). */
  totalInvoiced: string;
}

export interface MonthlyGrowth {
  month: string;
  label: string;
  /** Recognized revenue in the month (ledger, net of credit memos). */
  revenue: string;
  /** Invoiced revenue in the month (billings, reconciling series). */
  invoiced: string;
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
  totalRevenue: string;
  avgRevenue: string;
  /** Lifetime invoiced revenue (billings, reconciling column). */
  totalInvoiced: string;
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
  /**
   * Portfolio intelligence: either a score with its grade, or null with the
   * translated reason when no term carried weight — never a 0 that reads as
   * "scored worst".
   */
  intelligence: { score: number; label: string; grade: string } | { score: null; reason: string };
  kpis: {
    totalCustomers: number;
    /** Period recognized revenue across all customers (ties to P&L revenue). */
    totalRevenue: string;
    /** Period invoiced revenue across all customers (reconciling total). */
    totalInvoiced: string;
    avgCustomerValue: string;
    projectedClv: string;
    avgClv: string;
    champions: number;
    atRiskCount: number;
    atRiskRevenue: string;
    /** Null with no scored customers: no average exists. */
    retentionRate: number | null; // avg retention probability
    /** Null with no invoices: never a 0% that reads as "paid nothing". */
    paymentRate: number | null;
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
    fakeChampions: number | null;
  };
  segments: SegmentStat[];
  tierBreakdown: { tier: Tier; count: number; revenue: string; invoiced: string; threshold: string }[];
  growth: {
    monthly: MonthlyGrowth[];
    yoyGrowth: number | null;
    avgMonthlyGrowth: number;
    medianMonthlyRevenue: string;
    totalNewCustomers: number;
    trend: "growing" | "declining" | "stable";
  };
  cohorts: { list: Cohort[]; overallRetention: number };
  insights: Insight[];
  /**
   * The effective scoring thresholds the dashboard ran on (org overrides
   * over defaults) — the view renders scoring copy and bands from these,
   * never its own copies of the constants.
   */
  config: ConfigValuesOf<"customerIntelligence">;
}

/* ------------------------------------------------------------ Profitability */
// Project-financials profitability (faithful; kept from the first port), plus
// the fake-champion flag (revenue > $100k ∧ margin < 15%).

export type ProfitTier = "high" | "medium" | "low" | "marginal" | "loss";

export interface ProfitJob {
  jobId: string;
  jobName: string;
  revenue: string;
  costs: string;
  profit: string;
  /** Percentage points (24.7 not 0.247); null when the job has no revenue. */
  marginPct: number | null;
  transactionCount: number;
}

export interface ProfitCustomer {
  customerId: string;
  customerName: string;
  totalRevenue: string;
  totalCost: string;
  grossProfit: string;
  /** Percentage points; null when the customer has no revenue. */
  marginPct: number | null;
  profitTier: ProfitTier;
  isFakeChampion: boolean;
  jobs: ProfitJob[];
}

export interface ProfitabilitySummary {
  totalRevenue: string;
  totalCost: string;
  totalGrossProfit: string;
  /** Percentage points; null when no customer has revenue. */
  avgMarginPct: number | null;
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
  day: string;
  revenue: CustomerSqlNumeric;
  txn_count: CustomerSqlNumeric;
}

interface CustomerFrictionSqlRow {
  id: string;
  func: string | null;
  day: string;
  credit_count: CustomerSqlNumeric;
  order_count: CustomerSqlNumeric;
  credit_value: CustomerSqlNumeric;
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
  day: string;
  revenue: CustomerSqlNumeric;
  unique_customers: CustomerSqlNumeric;
  txn_count: CustomerSqlNumeric;
  new_customers: CustomerSqlNumeric;
}

export interface ProfitTierCutoffs {
  high: number;
  medium: number;
  low: number;
}

/**
 * Margin tier from the configured cut-offs. An undefined margin (no
 * revenue) is a loss when the customer cost money, marginal otherwise —
 * never a 0% that reads as "correctly nil".
 */
export function profitTierOf(marginPct: number | null, profit: string, cutoffs: ProfitTierCutoffs): ProfitTier {
  if (marginPct === null) return cmp(profit, "0") < 0 ? "loss" : "marginal";
  if (marginPct >= cutoffs.high) return "high";
  if (marginPct >= cutoffs.medium) return "medium";
  if (marginPct >= cutoffs.low) return "low";
  if (marginPct >= 0) return "marginal";
  return "loss";
}

export interface ProfitLeakCutoffs {
  /** Revenue share of the period total, in percentage points. */
  revenueSharePct: number;
  /** Leak candidates earn margin below this target, in percentage points. */
  marginTarget: number;
}

/**
 * A profit leak is relative, never an absolute amount: revenue share of the
 * period total at or above the configured share AND margin below the
 * configured target. Absolute cut-offs treat 100,000 JPY and 100,000 USD
 * the same; shares are currency-neutral.
 */
export function isProfitLeak(
  customer: { revenue: string; totalRevenue: string; marginPct: number | null },
  cutoffs: ProfitLeakCutoffs,
): boolean {
  if (customer.marginPct === null || customer.marginPct >= cutoffs.marginTarget) return false;
  if (cmp(customer.totalRevenue, "0") <= 0) return false;
  const share = evaluateAnalyticsRatio(customer.revenue, customer.totalRevenue, "percent", 2);
  if (share === null) return false;
  return cmp(share, String(cutoffs.revenueSharePct)) >= 0;
}

function emptyProfitability(): Profitability {
  return {
    customers: [],
    summary: {
      totalRevenue: "0",
      totalCost: "0",
      totalGrossProfit: "0",
      avgMarginPct: 0,
      customerCount: 0,
      totalJobs: 0,
      fakeChampions: 0,
      tierBreakdown: { high: 0, medium: 0, low: 0, marginal: 0, loss: 0 },
    },
  };
}

/**
 * Fail closed on hand-edited weight groups: the write path refuses a broken
 * sum, but a hand-edited settings blob bypasses it — a dashboard running on
 * partial weights would silently rescale every grade. The message names the
 * Configuration tab as the remedy.
 */
function requireValidWeights(
  cfg: ConfigValuesOf<"customerIntelligence">,
  strings: CustomerStrings,
): void {
  const violation = checkSumsTo(ANALYTICS_CONFIG.customerIntelligence, cfg);
  if (violation) {
    throw new Error(
      strings.scoringWeightsInvalid(
        violation.keys.join(", "),
        violation.total,
        Math.round(violation.actual * 100) / 100,
      ),
    );
  }
}

export async function customerProfitability(
  period: { from: string; to: string },
  orgId: string,
  allowed: ReadonlySet<string> | null,
  strings: CustomerStrings = customerStrings(englishCatalogMessage, "en"),
): Promise<Profitability> {
  // Job-costed margins join `projects`. When Projects is off that register is
  // not a live module — an empty result is not "no jobs this period".
  if (!orgId || !(await isFeatureEnabled(orgId, "projects"))) return emptyProfitability();
  const { from, to } = period;
  const orgFilter = orgId ? sql`and l.org_id = ${orgId}` : sql``;
  // The entry window materializes first. Joined inline, the planner drives
  // from accounts and probes the entry primary key once per journal line in
  // the tenant before the date filter narrows anything.
  const r = ((await analyticsQuery(sql`
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
      e.posting_date::date as day,
      -sum(case when a.type in ${REVENUE_TYPES} then l.amount else 0 end) as revenue,
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
    group by pr.customer_id, cp.display_name, pr.id, pr.name, sub.base_currency, e.posting_date::date
  `)));

  // Legs are stamped in their line entity's functional: translate each
  // (job, functional, posting day) leg at its own spot rate, then merge per job.
  interface ProfitLeg extends ProfitabilitySqlRow { func: string | null; day: string }
  const legs = r.rows as unknown as ProfitLeg[];
  const profitCtx = await flowRates(orgId, legs.map((leg) => ({
    func: leg.func ?? null,
    date: String(leg.day).slice(0, 10),
  })));
  const byCustomer = new Map<string, ProfitCustomer>();
  const byJob = new Map<string, { customer_id: string; customer_name: string; job_id: string; job_name: string; revenue: string; costs: string; txns: number }>();
  for (const leg of legs) {
    const key = `${leg.customer_id} ${leg.job_id}`;
    const date = String(leg.day).slice(0, 10);
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
    const revenue = merged.revenue;
    const costs = merged.costs;
    const profit = exactProfit(revenue, costs);
    // Skip empty projects (no revenue and no cost).
    if (cmp(revenue, "0") === 0 && cmp(costs, "0") === 0) continue;
    const job: ProfitJob = {
      jobId: merged.job_id,
      jobName: strings.displayJobName(merged.job_name),
      revenue,
      costs,
      profit,
      marginPct: exactMarginPercent(profit, revenue),
      transactionCount: merged.txns,
    };
    let c = byCustomer.get(merged.customer_id);
    if (!c) {
      c = { customerId: merged.customer_id, customerName: strings.displayCustomerName(merged.customer_name), totalRevenue: "0", totalCost: "0", grossProfit: "0", marginPct: null, profitTier: "marginal", isFakeChampion: false, jobs: [] };
      byCustomer.set(merged.customer_id, c);
    }
    c.jobs.push(job);
    c.totalRevenue = add(c.totalRevenue, revenue);
    c.totalCost = add(c.totalCost, costs);
  }

  // Profit tiers and the leak definition read the effective scoring config:
  // tiers and leaks are policy, never absolute amounts in the code.
  const cfg = await analyticsConfig(orgId, "customerIntelligence");
  requireValidWeights(cfg, strings);
  const tierCutoffs: ProfitTierCutoffs = {
    high: cfg.profitHighMargin!,
    medium: cfg.profitMediumMargin!,
    low: cfg.profitLowMargin!,
  };
  const leakCutoffs: ProfitLeakCutoffs = {
    revenueSharePct: cfg.profitLeakRevenueSharePct!,
    marginTarget: cfg.profitLeakMarginTarget!,
  };
  const totalRevenue = sum([...byCustomer.values()].map((c) => c.totalRevenue));
  const tierBreakdown: Record<ProfitTier, number> = { high: 0, medium: 0, low: 0, marginal: 0, loss: 0 };
  const customers = [...byCustomer.values()].map((c) => {
    c.grossProfit = exactProfit(c.totalRevenue, c.totalCost);
    c.marginPct = exactMarginPercent(c.grossProfit, c.totalRevenue);
    c.profitTier = profitTierOf(c.marginPct, c.grossProfit, tierCutoffs);
    c.isFakeChampion = isProfitLeak(
      { revenue: c.totalRevenue, totalRevenue, marginPct: c.marginPct },
      leakCutoffs,
    );
    c.jobs.sort((a, b) => cmp(b.revenue, a.revenue));
    tierBreakdown[c.profitTier]++;
    return c;
  });
  customers.sort((a, b) => cmp(b.totalRevenue, a.totalRevenue));

  const totalCost = sum(customers.map((c) => c.totalCost));
  const totalGrossProfit = exactProfit(totalRevenue, totalCost);

  return {
    customers,
    summary: {
      totalRevenue,
      totalCost,
      totalGrossProfit,
      avgMarginPct: exactMarginPercent(totalGrossProfit, totalRevenue),
      customerCount: customers.length,
      totalJobs: customers.reduce((a, c) => a + c.jobs.length, 0),
      fakeChampions: customers.filter((c) => c.isFakeChampion).length,
      tierBreakdown,
    },
  };
}

/* -------------------------------------------------------------- utilities */
/** Year-on-year growth as a ratio (0.056, not 5.6): exact through the ratio kernel. */
function yoyOf(revenue: string, priorRevenue: string): number | null {
  if (cmp(priorRevenue, "0") <= 0) return null;
  const text = evaluateAnalyticsRatio(add(revenue, neg(priorRevenue)), priorRevenue, "ratio", 4);
  return text === null ? null : Number(text);
}

/** the percentile: value at fraction p of a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** the percentile over exact decimal strings, compared — never subtracted. */
function percentileExact(sorted: string[], p: number): string {
  if (!sorted.length) return "0";
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

export interface PaymentScoreBands {
  highDays: number;
  highPenalty: number;
  mediumDays: number;
  mediumPenalty: number;
  lowDays: number;
  lowPenalty: number;
  perInvoice: number;
  cap: number;
}

export interface PaymentRatingBands {
  excellent: number;
  good: number;
  fair: number;
}

/**
 * Payment timing score from days-to-pay and overdue evidence. Null days-to-pay
 * means no paid invoice to measure timing against — the term is unknown, so no
 * score is awarded. Scoring an unmeasured customer 100 would read as flawless
 * payment behaviour for "never paid".
 */
export function scorePayment(
  avgDays: number | null,
  overdueCount: number,
  bands: PaymentScoreBands,
): number | null {
  if (avgDays === null) return null;
  let score = 100;
  if (avgDays > bands.highDays) score -= bands.highPenalty;
  else if (avgDays > bands.mediumDays) score -= bands.mediumPenalty;
  else if (avgDays > bands.lowDays) score -= bands.lowPenalty;
  if (overdueCount > 0) score -= Math.min(bands.cap, overdueCount * bands.perInvoice);
  return Math.max(0, score);
}

/** Payment rating from a timing score; an unscored term rates unknown, never excellent. */
export function ratePayment(
  score: number | null,
  bands: PaymentRatingBands,
): CustomerRow["paymentRating"] {
  if (score === null) return "unknown";
  if (score < bands.fair) return "poor";
  if (score < bands.good) return "fair";
  if (score < bands.excellent) return "good";
  return "excellent";
}

export interface HealthScoreTerms {
  recency: number;
  frequency: number;
  monetary: number;
  /** Null when the customer has no payment history to score. */
  payment: number | null;
}

export interface HealthScoreWeights {
  recency: number;
  frequency: number;
  monetary: number;
  payment: number;
}

/**
 * Composite health score from the terms that actually have data. A term with
 * no data is dropped and the remaining weights re-normalised — never awarded
 * phantom points. When no term is left (every present weight is zero) there is
 * no score at all: null with the caller naming the reason, never a 0 that
 * grades as F.
 */
export function healthScoreOf(
  terms: HealthScoreTerms,
  weights: HealthScoreWeights,
  frictionPenalty: number,
): { score: number | null; scoredWithoutPayment: boolean } {
  const payment = terms.payment;
  const scoredWithoutPayment = payment === null;
  const present = [
    { value: terms.recency, weight: weights.recency },
    { value: terms.frequency, weight: weights.frequency },
    { value: terms.monetary, weight: weights.monetary },
  ];
  if (payment !== null) present.push({ value: payment, weight: weights.payment });
  const total = present.reduce((a, t) => a + t.weight, 0);
  if (total <= 0) return { score: null, scoredWithoutPayment };
  const raw = present.reduce((a, t) => a + t.value * t.weight, 0);
  return { score: Math.max(0, Math.round(raw / total) - frictionPenalty), scoredWithoutPayment };
}

/**
 * Weighted composite of the terms that carry weight. No weighted term means no
 * composite — null, never a 0 that reads as "scored worst".
 */
export function compositeScoreOf(terms: { value: number; weight: number }[]): number | null {
  const total = terms.reduce((a, t) => a + t.weight, 0);
  if (total <= 0) return null;
  return Math.round(terms.reduce((a, t) => a + t.value * t.weight, 0) / total);
}

function priorYearIso(iso: string): string {
  return addMonthsClamped(iso, -12);
}

function customerDocumentMovements(
  orgId: string,
  kinds: string[],
  allowed: ReadonlySet<string> | null,
  from?: string,
  to?: string,
) {
  const kindFilter = sql`d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})`;
  const postedDateFilter = from && to ? sql`and d.posting_date::date between ${from}::date and ${to}::date` : sql``;
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed);
  return sql`
    select d.party_id, d.kind, sub.base_currency as func, d.posting_date::date as event_date,
           d.posting_date::date as posting_date, round(abs(d.total) * d.fx_rate, 4) as amount, 1::int as direction
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
     where d.org_id = ${orgId} and ${kindFilter} and d.status in ('posted', 'voided')
       and d.party_id is not null ${subsidiaryFilter} ${postedDateFilter}
    union all
    select d.party_id, d.kind, sub.base_currency as func,
           coalesce(reversal_entry.posting_date::date, d.voided_at::date) as event_date,
           d.posting_date::date as posting_date, round(abs(d.total) * d.fx_rate, 4) as amount, -1::int as direction
      from documents d
      left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
      left join journal_entries reversal_entry on reversal_entry.id = d.reversal_entry_id and reversal_entry.org_id = d.org_id
     where d.org_id = ${orgId} and ${kindFilter} and d.status = 'voided'
       and d.voided_at is not null and d.party_id is not null ${subsidiaryFilter}
       ${from && to ? sql`and coalesce(reversal_entry.posting_date::date, d.voided_at::date) between ${from}::date and ${to}::date` : sql``}
  `;
}

/* ------------------------------------------------------------------- main */
export interface CustomerSummary {
  kpis: Pick<CustomerData['kpis'], 'totalCustomers' | 'atRiskCount'> & { totalRevenue: string; totalInvoiced: string };
  growth: Pick<CustomerData['growth'], 'monthly'>;
}

export function customerData(
  period: { from: string; to: string; label: string }, orgId: string,
  allowed: ReadonlySet<string> | null,
  strings: CustomerStrings = customerStrings(englishCatalogMessage, "en"),
): Promise<CustomerData> {
  return readCustomerData(period, orgId, allowed, strings, false);
}

/** The card reads the same recognized revenue and churn model, without
 * lifetime cohorts, settlement detail or project profitability. */
export function customerSummaryData(
  period: { from: string; to: string; label: string }, orgId: string,
  allowed: ReadonlySet<string> | null,
  strings: CustomerStrings = customerStrings(englishCatalogMessage, "en"),
): Promise<CustomerSummary> {
  return readCustomerData(period, orgId, allowed, strings, true);
}

type CustomerPeriod = { from: string; to: string; label: string };
function readCustomerData(period: CustomerPeriod, orgId: string, allowed: ReadonlySet<string> | null, strings: CustomerStrings, preview: true): Promise<CustomerSummary>;
function readCustomerData(period: CustomerPeriod, orgId: string, allowed: ReadonlySet<string> | null, strings: CustomerStrings, preview: false): Promise<CustomerData>;
async function readCustomerData(
  period: CustomerPeriod, orgId: string, allowed: ReadonlySet<string> | null,
  strings: CustomerStrings, preview: boolean,
): Promise<CustomerData | CustomerSummary> {
  const { moneyCompact } = await getMoneyFormatter(orgId)
  const { from, to } = period;
  const pFrom = priorYearIso(from);
  const pTo = priorYearIso(to);
  // Recency/overdue are measured "as of now", never a future period end.
  const today = await businessToday(orgId);
  const ref = to < today ? to : today;

  // The scoring model (defaults reproduce the standard scoring exactly).
  const cfg = await analyticsConfig(orgId, "customerIntelligence");
  requireValidWeights(cfg, strings);
  // mergeConfig always materializes every default key for the dashboard.
  const churnCritical = cfg.churnCriticalScore!;
  const churnHigh = cfg.churnHighScore!;
  const churnMedium = cfg.churnMediumScore!;
  const hhiWarning = cfg.hhiWarning!;
  const hhiCritical = cfg.hhiCritical!;
  const clvYears = cfg.clvYears!;
  const weightRecency = cfg.healthWeightRecency!;
  const weightFrequency = cfg.healthWeightFrequency!;
  const weightMonetary = cfg.healthWeightMonetary!;
  const weightPayment = cfg.healthWeightPayment!;
  const intelChampions = cfg.intelWeightChampions!;
  const intelRetention = cfg.intelWeightRetention!;
  const intelConcentration = cfg.intelWeightConcentration!;
  const intelPayment = cfg.intelWeightPayment!;
  const gradeAPlus = cfg.gradeAPlus!;
  const gradeA = cfg.gradeA!;
  const gradeB = cfg.gradeB!;
  const gradeC = cfg.gradeC!;
  const gradeD = cfg.gradeD!;
  const recencyGood = cfg.recencyGoodDays!;
  const recencyWarning = cfg.recencyWarningDays!;
  const recencyCritical = cfg.recencyCriticalDays!;
  const churnHighDays = cfg.churnHighDays!;
  const churnMediumDays = cfg.churnMediumDays!;
  const churnLowDays = cfg.churnInactiveLowDays!;
  const churnCriticalPts = cfg.churnInactiveCriticalPoints!;
  const churnHighPts = cfg.churnInactiveHighPoints!;
  const churnLowPts = cfg.churnInactiveLowPoints!;
  const churnCadenceHighX = cfg.churnCadenceHighMultiple!;
  const churnCadenceLowX = cfg.churnCadenceLowMultiple!;
  const churnCadenceHighPts = cfg.churnCadenceHighPoints!;
  const churnCadenceLowPts = cfg.churnCadenceLowPoints!;
  const churnSingleTxns = cfg.churnSingleMaxTxns!;
  const churnFewTxns = cfg.churnFewMaxTxns!;
  const churnSinglePts = cfg.churnSinglePoints!;
  const churnFewPts = cfg.churnFewPoints!;
  const clvMinYears = cfg.clvMinYears!;
  const clvBase = cfg.clvRetentionBase! / 100;
  const clvDecay = cfg.clvRetentionDecayDays!;
  const clvMin = cfg.clvRetentionMinPct! / 100;
  const clvMax = cfg.clvRetentionMaxPct! / 100;
  const tierPlatinum = cfg.tierPlatinumPct! / 100;
  const tierGold = cfg.tierGoldPct! / 100;
  const tierSilver = cfg.tierSilverPct! / 100;
  const concCritical = cfg.concentrationCriticalShare!;
  const concHigh = cfg.concentrationHighShare!;
  const concMedium = cfg.concentrationMediumShare!;
  const concCoverage = cfg.concentrationCoverageShare!;
  const topSlice = cfg.topSharePct! / 100;
  const frictionPerCredit = cfg.frictionPointsPerCredit!;
  const frictionCriticalCut = cfg.frictionCriticalPoints!;
  const frictionHighCut = cfg.frictionHighPoints!;
  const frictionMediumCut = cfg.frictionMediumPoints!;
  const frictionCriticalPts = cfg.frictionPenaltyCritical!;
  const frictionHighPts = cfg.frictionPenaltyHigh!;
  const frictionMediumPts = cfg.frictionPenaltyMedium!;
  const frictionCriticalRate = cfg.frictionCriticalRate!;
  const frictionHighRate = cfg.frictionHighRate!;
  const frictionMediumRate = cfg.frictionMediumRate!;
  const dsoHighDays = cfg.paymentDsoHighDays!;
  const dsoHighPts = cfg.paymentDsoHighPenalty!;
  const dsoMediumDays = cfg.paymentDsoMediumDays!;
  const dsoMediumPts = cfg.paymentDsoMediumPenalty!;
  const dsoLowDays = cfg.paymentDsoLowDays!;
  const dsoLowPts = cfg.paymentDsoLowPenalty!;
  const overduePerInvoice = cfg.paymentOverduePerInvoice!;
  const overdueCap = cfg.paymentOverdueCap!;
  const ratingExcellent = cfg.paymentRatingExcellent!;
  const ratingGood = cfg.paymentRatingGood!;
  const ratingFair = cfg.paymentRatingFair!;
  const nurtureHealth = cfg.nurtureMinHealth!;
  const nurturePercentile = cfg.nurtureClvPercentile! / 100;
  const maturityFloor = cfg.growthMaturityFloorPct! / 100;
  const momCapUp = cfg.growthMomCapUp!;
  const momCapDown = cfg.growthMomCapDown!;
  const trendBand = cfg.growthTrendPct!;
  const yoyWindow = cfg.growthYoyWindowMonths!;
  const overdueInsightAt = cfg.overdueInsightCount!;

  const [baseRows, frictionRows, paymentRows, growthRows, growthCounts, cohortRows, ledgerRows, growthLedgerRows, cohortLedgerRows, profitData, dsoStats] = await Promise.all([
    // Base customer metrics — the header query over CustInvc(+CashSale):
    // per-customer invoice count / INVOICED revenue / first-last dates /
    // recency / tenure. This is the billing-activity population the ledger
    // money (recognized + recon) merges onto; YoY context now reads prior
    // recognized revenue from the ledger legs, so no prior-year doc legs.
    // documents.total is transaction currency: the first leg translates at
    // the posted document rate to the posting subsidiary's functional; the
    // second leg to presentation runs per posting date below, so a rate move
    // inside the window prices each day's billings at that day's rate.
    (analyticsQuery(sql`
      with movement as (${customerDocumentMovements(orgId, ['customer_invoice', 'cash_sale'], allowed, from, to)})
      select movement.party_id as id, coalesce(p.display_name, 'Unknown') as name,
        movement.func,
        movement.event_date::date as day,
        sum(movement.direction) as txn_count,
        sum(movement.amount * movement.direction) as revenue
      from movement
      join parties p on p.id = movement.party_id and p.org_id = ${orgId}
      group by movement.party_id, p.display_name, movement.func, movement.event_date::date
    `)),
    // Friction — credit memos per customer (returns×3 + credits×2;
    // this ledger has no return-auth kind, so returns are always 0).
    // Credit value translates per posting date below.
    (preview ? Promise.resolve({ rows: [] }) : analyticsQuery(sql`
      with movement as (${customerDocumentMovements(orgId, ['customer_credit', 'cash_refund', 'customer_invoice'], allowed, from, to)})
      select movement.party_id as id, movement.func,
        movement.event_date::date as day,
        sum(movement.direction) filter (where movement.kind in ('customer_credit', 'cash_refund')) as credit_count,
        coalesce(sum(movement.amount * movement.direction) filter (where movement.kind in ('customer_credit', 'cash_refund')), 0) as credit_value,
        sum(movement.direction) filter (where movement.kind = 'customer_invoice') as order_count
      from movement
      group by movement.party_id, movement.func, movement.event_date::date
    `)),
    // Payment behaviour — paid = fully-applied invoice; days-to-pay = final
    // application date − invoice date; overdue =
    // past due and not fully paid, as of the reference date.
    (preview ? Promise.resolve({ rows: [] }) : analyticsQuery(sql`
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
        where d.org_id = ${orgId} and d.kind = 'customer_invoice'
          and (d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${ref}::date))
          ${subsidiaryVisibleFilter(sql`il.subsidiary_id`, allowed)}
          and d.party_id is not null
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
    (analyticsQuery(sql`
      with movement as (${customerDocumentMovements(orgId, ['customer_invoice', 'cash_sale'], allowed, from, to)})
      select to_char(movement.event_date, 'YYYY-MM') as month,
        movement.func,
        movement.event_date::date as day,
        sum(movement.amount * movement.direction) as revenue
      from movement
      group by 1, 2, 3 order by 1
    `)),
    // Growth counts — distinct customers never merge across functionals, so
    // they stay on their own month grain while revenue translates above.
    (analyticsQuery(sql`
      with movement as (${customerDocumentMovements(orgId, ['customer_invoice', 'cash_sale'], allowed, from, to)}),
      monthly as (
        select party_id, date_trunc('month', event_date) as month, sum(direction) as txn_count
          from movement group by party_id, date_trunc('month', event_date)
      ), first_doc as (
        select party_id, min(date_trunc('month', posting_date)) as first_month
          from documents
         where org_id = ${orgId} and kind in ('customer_invoice', 'cash_sale', 'sales_order')
           and status in ('posted', 'voided') and party_id is not null
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}
         group by party_id
      )
      select to_char(monthly.month, 'YYYY-MM') as month,
        count(*) filter (where monthly.txn_count <> 0)::int as unique_customers,
        sum(monthly.txn_count) as txn_count,
        count(*) filter (where first_doc.first_month = monthly.month and monthly.txn_count > 0)::int as new_customers
      from monthly
      join first_doc on first_doc.party_id = monthly.party_id
      group by monthly.month order by monthly.month
    `)),
    // Cohorts — lifetime per-customer first/last order + lifetime revenue;
    // grouped into join-year cohorts below (active = ordered in last 6 months).
    // Lifetime revenue translates per posting date below.
    (preview || !analyticsSection('customer-intelligence', ['growth']) ? Promise.resolve({ rows: [] }) : analyticsQuery(sql`
      with movement as (${customerDocumentMovements(orgId, ['customer_invoice'], allowed)})
      select movement.party_id as id, movement.func,
        movement.event_date::date as day,
        max(movement.posting_date) filter (where movement.direction > 0) as last_order,
        min(movement.posting_date) filter (where movement.direction > 0) as first_order,
        sum(movement.amount * movement.direction) as lifetime_revenue
      from movement
      group by movement.party_id, movement.func, movement.event_date::date
    `)),
    // Recognized revenue + recon legs, per (customer, functional) — the SAME
    // universe the P&L reads (REVENUE_TYPES legs on posted/reversed entries in
    // the statement book), cut per customer. Attribution is direct through the
    // line party (invoices, credit memos and party-tagged manuals all stamp
    // it — credit memos carry the same dims as the sale, so no unallocated
    // bucket) plus recognition schedules, whose legs carry no party and are
    // attributed through the contract customer instead. Amounts are stored
    // base (functional), translated to presentation per posting day below —
    // never re-derived from document rates, so single-currency reads cannot
    // drift from the P&L resolver.
    // Reversed entries and their mirrors stay IN (they net, exactly as the P&L
    // nets them); the recon separates their period effect into `voids`.
    (analyticsQuery(sql`
      with ew as materialized (
        select id, posting_date, status, origin, source_document_id,
               (reverses_entry_id is not null or status = 'reversed') as is_void
          from journal_entries
         where org_id = ${orgId}
           and posting_date >= ${pFrom} and posting_date <= ${to}
           and status in ('posted', 'reversed')
           and book_id = ${statementBookExpr(orgId)}
      )
      -- One row per (party, functional, posting day): each bucket below
      -- filters on that day, so translating the row at its own date prices
      -- every posting at its own spot rate — never at the window's latest.
      select coalesce(l.party_id, rc.customer_id) as id,
        sub.base_currency as func,
        e.posting_date::date as day,
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
          where a.type in ${REVENUE_TYPES} and e.is_void and e.origin <> 'revenue_recognition'
            and (d.id is null or d.kind not in ('customer_invoice', 'customer_credit'))
            and e.posting_date >= ${from}) as voids
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = ${orgId}
      join accounts a on a.id = l.account_id and a.org_id = ${orgId}
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
      left join documents d on d.id = e.source_document_id and d.org_id = ${orgId}
      -- Schedules carry no party, so their legs attribute through the contract
      -- customer — including cancellation mirrors, which link back through
      -- reversal_journal_entry_id (the cancellation route flips the original to
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
      group by 1, 2, 3
    `)),
    // Recognized revenue per month (ledger posting month — recognition timing,
    // not billing month; the gap between this and the invoiced series IS the
    // timing story). Invoiced monthly stays on the document query above.
    (analyticsQuery(sql`
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
        e.posting_date::date as day,
        -sum(l.amount) as recognized
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = ${orgId}
      join accounts a on a.id = l.account_id and a.org_id = ${orgId}
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
      -- Schedules carry no party, so their legs attribute through the contract
      -- customer — including cancellation mirrors, which link back through
      -- reversal_journal_entry_id (the cancellation route flips the original to
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
      group by 1, 2, 3 order by 1
    `)),
    // Lifetime recognized per customer, for cohorts (lifetime invoiced stays
    // on the document query above).
    (preview || !analyticsSection('customer-intelligence', ['growth']) ? Promise.resolve({ rows: [] }) : analyticsQuery(sql`
      with ew as materialized (
        select id, posting_date, origin
          from journal_entries
         where org_id = ${orgId}
           and status in ('posted', 'reversed')
           and book_id = ${statementBookExpr(orgId)}
      )
      select coalesce(l.party_id, rc.customer_id) as id,
        sub.base_currency as func,
        e.posting_date::date as day,
        -sum(l.amount) as recognized
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = ${orgId}
      join accounts a on a.id = l.account_id and a.org_id = ${orgId}
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = ${orgId}
      -- Schedules carry no party, so their legs attribute through the contract
      -- customer — including cancellation mirrors, which link back through
      -- reversal_journal_entry_id (the cancellation route flips the original to
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
      group by 1, 2, 3
    `)),
    preview || !analyticsSection('customer-intelligence', ['lifetime', 'profitability']) ? Promise.resolve(null) : customerProfitability(period, orgId, allowed),
    // The header "Avg DSO" is the ONE org DSO — the same settlement-weighted
    // trailing mean the cash cockpit, cashflow analytics, MCP cashflow tool,
    // and get_vitals read — never a second per-customer grain computed here.
    preview ? Promise.resolve(null) : paymentStats("ar", ref, allowed ? [...allowed] : undefined, orgId),
  ]);

  /* ---- recognized revenue + recon (ledger universe, per party) ---- */
  interface LedgerSqlRow {
    id: string;
    func: string | null;
    day: string;
    recognized: CustomerSqlNumeric;
    prior_recognized: CustomerSqlNumeric;
    credits: CustomerSqlNumeric;
    tax: CustomerSqlNumeric;
    inv_income: CustomerSqlNumeric;
    inv_nonar: CustomerSqlNumeric;
    sched: CustomerSqlNumeric;
    voids: CustomerSqlNumeric;
  }
  interface LedgerParty {
    recognized: string; priorRecognized: string; credits: string; tax: string;
    parked: string; sched: string; voids: string;
  }
  // Legs arrive per (party, functional, posting day) in stored base amounts;
  // translate each row at its own posting date, then merge per party — the
  // same per-date pattern the document measures use, so FX handling cannot
  // diverge. flowRates fails closed on a missing rate: no silent 1:1.
  const ledgerLegs = ledgerRows.rows as unknown as LedgerSqlRow[];
  const ledgerCtx = await flowRates(orgId, ledgerLegs.map((r) => ({
    func: r.func ?? null, date: String(r.day).slice(0, 10),
  })));
  const ledgerByParty = new Map<string, LedgerParty>();
  const zeroLedger = (): LedgerParty => ({
    recognized: "0", priorRecognized: "0", credits: "0", tax: "0",
    parked: "0", sched: "0", voids: "0",
  });
  for (const r of ledgerLegs) {
    const cur = ledgerByParty.get(r.id) ?? zeroLedger();
    const day = String(r.day).slice(0, 10);
    const at = (v: CustomerSqlNumeric) =>
      mulDecimal(String(v ?? 0), ledgerCtx.rateAt(r.func ?? null, day));
    cur.recognized = add(cur.recognized, at(r.recognized));
    if (r.prior_recognized != null) {
      cur.priorRecognized = add(cur.priorRecognized, at(r.prior_recognized));
    }
    cur.credits = add(cur.credits, at(r.credits));
    cur.tax = add(cur.tax, at(r.tax));
    // Parked = invoice net routed to deferred liability: invoice income legs
    // minus every non-AR ex-tax leg on the same invoice entries (income +
    // deferred). Zero for a directly-earned invoice, the full net when parked.
    cur.parked = add(cur.parked, at(add(String(r.inv_income ?? 0), neg(String(r.inv_nonar ?? 0)))));
    cur.sched = add(cur.sched, at(r.sched));
    cur.voids = add(cur.voids, at(r.voids));
    ledgerByParty.set(r.id, cur);
  }

  /* ---- base metrics ---- */
  interface Base {
    id: string; name: string; revenue: string; priorRevenue: string;
    invoicedRevenue: string; recon: CustomerRevenueRecon;
    txns: number; avgValue: string;
    first: string | null; last: string | null; recency: number | null; tenure: number;
  }
  // Invoiced revenue arrives per (party, functional, posting day) at the
  // posted document rate; translate each day at its own spot rate, then merge
  // per party. Average = translated invoiced revenue per invoice. Parties
  // whose translated movement nets to nothing with no transactions stay out,
  // exactly like the query-level filter this replaces.
  const baseLegs = baseRows.rows as unknown as CustomerBaseSqlRow[];
  const baseCtx = await flowRates(orgId, baseLegs.map((r) => ({
    func: r.func ?? null, date: String(r.day).slice(0, 10),
  })));
  const baseByParty = new Map<string, { name: string; revenue: string; txns: number; first: string | null; last: string | null }>();
  for (const r of baseLegs) {
    const cur = baseByParty.get(r.id) ?? { name: String(r.name), revenue: "0", txns: 0, first: null as string | null, last: null as string | null };
    const day = String(r.day).slice(0, 10);
    cur.revenue = add(cur.revenue, mulDecimal(String(r.revenue ?? 0), baseCtx.rateAt(r.func ?? null, day)));
    cur.txns += Number(r.txn_count ?? 0);
    if (!cur.first || day < cur.first) cur.first = day;
    if (!cur.last || day > cur.last) cur.last = day;
    baseByParty.set(r.id, cur);
  }
  for (const [id, c] of baseByParty) {
    if (cmp(c.revenue, "0") === 0 && c.txns === 0) baseByParty.delete(id);
  }
  const base: Base[] = [...baseByParty.entries()].map(([id, c]) => {
    // Headline money is RECOGNIZED (ledger); invoiced stays alongside as the
    // reconciling column. Population, counts and dates stay document-based:
    // they describe billing activity, not earned value.
    // The invoiced→recognized bridge identity is money arithmetic, so every
    // leg stays an exact decimal string from the ledger to the tile: float
    // subtraction on ledger amounts leaves dust in `other`, which the
    // durable recon test pins to zero for pure document flows. Numbers
    // cross only at chart coordinates (toChartNumber) and display percents
    // (evaluateAnalyticsRatio, rounded once).
    const led = ledgerByParty.get(id);
    const invoicedExact = c.revenue;
    const recognizedExact = led?.recognized ?? "0";
    const taxExact = led?.tax ?? "0";
    const creditsExact = led?.credits ?? "0";
    const timingDeferredExact = led?.parked ?? "0";
    const timingRecognizedExact = led?.sched ?? "0";
    const voidsExact = led?.voids ?? "0";
    const explainedExact = add(
      add(taxExact, creditsExact),
      add(add(timingDeferredExact, neg(timingRecognizedExact)), voidsExact),
    );
    const otherExact = add(add(invoicedExact, neg(recognizedExact)), neg(explainedExact));
    return {
      id,
      name: c.name,
      revenue: recognizedExact,
      priorRevenue: led?.priorRecognized ?? "0",
      invoicedRevenue: invoicedExact,
      recon: {
        tax: taxExact,
        credits: creditsExact,
        timingDeferred: timingDeferredExact,
        timingRecognized: timingRecognizedExact,
        voids: voidsExact,
        // Residual, not a plug target: manual-journal income with a party tag
        // and FX/rounding dust land here. The durable recon test pins it to
        // zero for pure document flows and to the manual amount when seeded.
        other: otherExact,
      },
      txns: c.txns,
      // Billing behavior (average invoice size), not earned value — pairs with
      // invoice counts, which are document-based too.
      avgValue: c.txns > 0 ? div(invoicedExact, String(c.txns)) : "0",
      first: c.first,
      last: c.last,
      recency: c.last ? Math.max(0, calendarDaysBetween(c.last, ref)) : null,
      tenure: c.first && c.last ? calendarDaysBetween(c.first, c.last) : 0,
    };
  });

  /* ---- RFM () ---- */
  const freqSorted = base.map((c) => c.txns).sort((a, b) => a - b);
  const monSorted = base.map((c) => c.revenue).sort(cmp);
  const freqP33 = percentile(freqSorted, 0.33);
  const freqP66 = percentile(freqSorted, 0.66);
  const monP33 = percentileExact(monSorted, 0.33);
  const monP66 = percentileExact(monSorted, 0.66);

  const rfmOf = (c: Base) => {
    // Unknown recency never reads as fresh: it scores the stalest band so an
    // undated customer flags for attention instead of looking like a champion.
    // (Movement rows always carry dates, so this is defensive, not a live path.)
    const recency = c.recency ?? Number.MAX_SAFE_INTEGER;
    let r = 1;
    if (recency <= recencyGood) r = 5;
    else if (recency <= recencyWarning) r = 3;
    else if (recency <= recencyCritical) r = 2;
    let f = 1;
    if (c.txns > freqP66) f = 5;
    else if (c.txns > freqP33) f = 3;
    let m = 1;
    if (cmp(c.revenue, monP66) > 0) m = 5;
    else if (cmp(c.revenue, monP33) > 0) m = 3;

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
    // Annualized from invoiced revenue directly (average value × frequency
    // per year reduces to invoiced ÷ years): the money never crosses into a
    // float. The retention curve is statistical by nature; it rounds once to
    // the integer retention factor, and the projection multiplies exact legs.
    const yearsActive = Math.max(clvMinYears, c.tenure / DAYS_PER_YEAR);
    const annualValue = div(c.invoicedRevenue, yearsActive.toFixed(10));
    const recency = c.recency ?? Number.MAX_SAFE_INTEGER;
    const retention = Math.max(clvMin, Math.min(clvMax, clvBase * Math.exp(-recency / clvDecay)));
    const retentionFactor = Math.round(retention * 100);
    const clv = mulDecimal(mulDecimal(annualValue, String(clvYears)), div(String(retentionFactor), "100"));
    return { annualValue, clv, retentionFactor };
  };

  /* ---- churn () ---- */
  const churnOf = (c: Base) => {
    // Unknown recency scores the critical inactivity points (see rfmOf): an
    // undated customer flags for attention instead of reading as healthy.
    // (Movement rows always carry dates, so this is defensive, not a live path.)
    const recency = c.recency;
    let score = 0;
    const factors: string[] = [];
    if (recency === null) { score += churnCriticalPts; factors.push(strings.churnDeclining); }
    else if (recency > churnHighDays) { score += churnCriticalPts; factors.push(strings.churnInactive(recency)); }
    else if (recency > churnMediumDays) { score += churnHighPts; factors.push(strings.churnDeclining); }
    else if (recency > churnLowDays) score += churnLowPts;
    const avgDaysBetween = c.tenure / Math.max(1, c.txns);
    const stale = recency === null || recency > avgDaysBetween * churnCadenceHighX;
    const slowing = recency !== null && recency > avgDaysBetween * churnCadenceLowX;
    if (stale) { score += churnCadenceHighPts; factors.push(strings.churnBelowPattern); }
    else if (slowing) score += churnCadenceLowPts;
    if (c.txns <= churnSingleTxns) { score += churnSinglePts; factors.push(strings.churnSingle); }
    else if (c.txns <= churnFewTxns) { score += churnFewPts; factors.push(strings.churnLowFrequency); }
    score = Math.min(100, score);
    const level: RiskLevel = score >= churnCritical ? "critical" : score >= churnHigh ? "high" : score >= churnMedium ? "medium" : "low";
    return { score, level, factors, retentionProbability: Math.max(0, 100 - score), avgDaysBetween: Math.round(avgDaysBetween) };
  };

  /* ---- velocity () ---- */
  const velocityOf = (c: Base) => {
    // Unknown recency shows no lateness: velocity measures overdue evidence
    // and unknown is not evidence (churn already flags undated customers).
    const recency = c.recency ?? 0;
    const cycle = c.tenure > 0 && c.txns > 1 ? c.tenure / (c.txns - 1) : 30;
    const nextIn = Math.max(0, cycle - recency);
    const overdue = Math.max(0, recency - cycle);
    let urgency: CustomerRow["urgency"] = "on-track";
    if (overdue > cycle) urgency = "critical";
    else if (overdue > cycle * 0.5) urgency = "high";
    else if (overdue > 0) urgency = "medium";
    else if (nextIn <= 7) urgency = "due-soon";
    return { cycle: Math.round(cycle), overdue: Math.round(overdue), urgency, hasPattern: c.txns >= 2 };
  };

  /* ---- friction / payment lookups ---- */
  // Credit value arrives per (party, functional, posting day): translate each
  // day at its own spot rate, then merge per party. Parties without invoice
  // orders stay out, exactly like the query-level filter this replaces.
  const frictionLegs = frictionRows.rows as unknown as CustomerFrictionSqlRow[];
  const frictionCtx = await flowRates(orgId, frictionLegs.map((r) => ({
    func: r.func ?? null, date: String(r.day).slice(0, 10),
  })));
  const frictionByParty = new Map<string, { credits: number; orders: number; creditValue: string }>();
  for (const r of frictionLegs) {
    const cur = frictionByParty.get(r.id) ?? { credits: 0, orders: 0, creditValue: "0" };
    cur.credits += Number(r.credit_count ?? 0);
    cur.orders += Number(r.order_count ?? 0);
    cur.creditValue = add(cur.creditValue, mulDecimal(String(r.credit_value ?? 0), frictionCtx.rateAt(r.func ?? null, String(r.day).slice(0, 10))));
    frictionByParty.set(r.id, cur);
  }
  for (const [id, f] of frictionByParty) {
    if (f.orders === 0) frictionByParty.delete(id);
  }
  const frictionMap = new Map<string, { points: number; level: RiskLevel; credits: number; creditValue: string; returnRate: number }>();
  for (const [id, f] of frictionByParty) {
    const credits = f.credits;
    const orders = f.orders;
    const points = credits * frictionPerCredit; // returns×3 unavailable — no return-auth kind
    const returnRate = orders > 0 ? (credits / orders) * 100 : 0;
    let level: RiskLevel = "low";
    if (points >= frictionCriticalCut || returnRate >= frictionCriticalRate) level = "critical";
    else if (points >= frictionHighCut || returnRate >= frictionHighRate) level = "high";
    else if (points >= frictionMediumCut || returnRate >= frictionMediumRate) level = "medium";
    if (points > 0) frictionMap.set(id, { points, level, credits, creditValue: f.creditValue, returnRate: Math.round(returnRate * 10) / 10 });
  }

  const paymentMap = new Map<string, { score: number | null; rating: CustomerRow["paymentRating"]; avgDays: number | null; overdue: number; rate: number | null }>();
  let totInvoices = 0, totPaid = 0, totOverdue = 0;
  const scoreBands: PaymentScoreBands = {
    highDays: dsoHighDays, highPenalty: dsoHighPts,
    mediumDays: dsoMediumDays, mediumPenalty: dsoMediumPts,
    lowDays: dsoLowDays, lowPenalty: dsoLowPts,
    perInvoice: overduePerInvoice, cap: overdueCap,
  };
  const ratingBands: PaymentRatingBands = { excellent: ratingExcellent, good: ratingGood, fair: ratingFair };
  for (const r of paymentRows.rows as unknown as CustomerPaymentSqlRow[]) {
    const invoices = Number(r.invoice_count ?? 0);
    const paid = Number(r.paid_count ?? 0);
    const overdue = Number(r.overdue_count ?? 0);
    const avgDays = r.avg_days_to_pay === null ? null : Number(r.avg_days_to_pay);
    totInvoices += invoices; totPaid += paid; totOverdue += overdue;
    const score = scorePayment(avgDays, overdue, scoreBands);
    const rating = ratePayment(score, ratingBands);
    paymentMap.set(r.id, { score, rating, avgDays: avgDays === null ? null : Math.round(avgDays), overdue, rate: invoices > 0 ? Math.round((paid / invoices) * 100) : null });
  }
  // No invoices means no payment rate — never a 0% that reads as "paid nothing".
  const paymentRate = totInvoices > 0 ? Math.round((totPaid / totInvoices) * 100) : null;
  const profitMap = new Map((profitData?.customers ?? []).map((c) => [c.customerId, c]));

  /* ---- assemble per-customer, CLV tiers by rank ---- */
  const enriched = base.map((c) => {
    const rfm = rfmOf(c);
    const clv = clvOf(c);
    const churn = churnOf(c);
    const vel = velocityOf(c);
    return { c, rfm, clv, churn, vel };
  });
  // Tier assignment ranks by projected CLV.
  const byClv = [...enriched].sort((a, b) => cmp(b.clv.clv, a.clv.clv));
  const nAll = byClv.length;
  const platinumCutoff = Math.ceil(nAll * tierPlatinum);
  const goldCutoff = Math.ceil(nAll * tierGold);
  const silverCutoff = Math.ceil(nAll * tierSilver);
  const tierByCustomer = new Map<string, { tier: Tier; rank: number }>();
  byClv.forEach((e, i) => {
    const tier: Tier = i < platinumCutoff ? "platinum" : i < goldCutoff ? "gold" : i < silverCutoff ? "silver" : "bronze";
    tierByCustomer.set(e.c.id, { tier, rank: i + 1 });
  });
  const tierThresholds: Record<Tier, string> = {
    platinum: byClv[platinumCutoff - 1]?.clv.clv ?? "0",
    gold: byClv[goldCutoff - 1]?.clv.clv ?? "0",
    silver: byClv[silverCutoff - 1]?.clv.clv ?? "0",
    bronze: "0",
  };

  /* ---- concentration () ---- */
  const totalRevenueExact = sum([...baseByParty.keys()].map((id) => ledgerByParty.get(id)?.recognized ?? "0"));
  const totalInvoicedExact = sum([...baseByParty.values()].map((customer) => customer.revenue));
  const totalRevenuePositive = cmp(totalRevenueExact, "0") > 0;
  const byRevenue = [...enriched].sort((a, b) => cmp(b.c.revenue, a.c.revenue));
  const shareMap = new Map<string, { sharePct: number; risk: RiskLevel }>();
  let cumulative = "0";
  let customersFor80Pct = 0;
  const shareTexts = new Map<string, string>();
  byRevenue.forEach((e, i) => {
    const shareText = totalRevenuePositive
      ? evaluateAnalyticsRatio(e.c.revenue, totalRevenueExact, "percent", 2)
      : "0.00";
    if (shareText === null) throw new Error("CUSTOMER_REVENUE_SHARE_UNDEFINED");
    const sharePct = Number(shareText);
    const shareComparison = cmp(shareText, String(concCritical)) >= 0 ? "critical"
      : cmp(shareText, String(concHigh)) >= 0 ? "high"
        : cmp(shareText, String(concMedium)) >= 0 ? "medium" : "low";
    const risk: RiskLevel = shareComparison;
    cumulative = add(cumulative, shareText);
    if (cmp(cumulative, String(concCoverage)) <= 0) customersFor80Pct = i + 1;
    shareMap.set(e.c.id, { sharePct, risk });
    shareTexts.set(e.c.id, shareText);
  });
  // HHI is a dimensionless index, not money: each share squares exactly and
  // the single float crossing rounds once for the displayed integer.
  const hhiExact = sum([...shareTexts.values()].map((share) => mulDecimal(share, share)));
  const hhiScaled = Math.round(Number(hhiExact));
  const hhiLevel: CustomerData["kpis"]["hhiLevel"] = hhiScaled >= hhiCritical ? "high" : hhiScaled >= hhiWarning ? "moderate" : "low";
  const top10PctCount = Math.ceil(nAll * topSlice);
  const top10ShareText = totalRevenuePositive
    ? evaluateAnalyticsRatio(
      sum(byRevenue.slice(0, top10PctCount).map((e) => e.c.revenue)),
      totalRevenueExact,
      "percent",
      0,
    )
    : "0";
  if (top10ShareText === null) throw new Error("TOP_CUSTOMER_REVENUE_SHARE_UNDEFINED");
  const top10Share = Number(top10ShareText);

  // Nurture cut: the configured percentile of the CLV distribution — a
  // relative bar that moves with the book, never an absolute amount.
  const nurtureClvCut = percentileExact(enriched.map((e) => e.clv.clv).sort(cmp), nurturePercentile);

  /* ---- health scores + recommendations (weights from the scoring config) ---- */
  const gradeOf = (h: number): CustomerRow["healthGrade"] =>
    h >= gradeAPlus ? "A+" : h >= gradeA ? "A" : h >= gradeB ? "B" : h >= gradeC ? "C" : h >= gradeD ? "D" : "F";
  const rows: CustomerRow[] = enriched.map(({ c, rfm, clv, churn, vel }) => {
    const friction = frictionMap.get(c.id);
    const payment = paymentMap.get(c.id);
    const profit = profitMap.get(c.id);
    const share = shareMap.get(c.id)!;
    const tierInfo = tierByCustomer.get(c.id)!;

    const recencyScore = rfm.r * 20;
    const frequencyScore = rfm.f * 20;
    const monetaryScore = rfm.m * 20;
    const frictionPenalty = friction?.level === "critical" ? frictionCriticalPts : friction?.level === "high" ? frictionHighPts : friction?.level === "medium" ? frictionMediumPts : 0;
    // A term with no data is dropped and the remaining weights re-normalised:
    // with no payment history — or timing too thin to score, with no paid
    // invoice to measure against — the customer earns no phantom points, and
    // the tile says so by name (scoredWithoutPayment). When no term is left at
    // all there is no score: null, never a 0 that grades as F.
    const paymentScore = payment?.score ?? null;
    const { score: healthScore, scoredWithoutPayment } = healthScoreOf(
      { recency: recencyScore, frequency: frequencyScore, monetary: monetaryScore, payment: paymentScore },
      { recency: weightRecency, frequency: weightFrequency, monetary: weightMonetary, payment: weightPayment },
      frictionPenalty,
    );
    const healthGrade: CustomerRow["healthGrade"] = healthScore === null ? null : gradeOf(healthScore);

    // 7-priority recommendation ladder, verbatim.
    let recommendation: Recommendation = "maintain";
    let detail = strings.recMaintain;
    const velOverdue = vel.hasPattern ? vel.overdue : 0;
    // A leak candidate always carries a margin: the leak definition refuses
    // undefined margins, so the reprice sentence always has a figure.
    const leakMargin: number | null = profit && profit.isFakeChampion ? profit.marginPct : null;
    if (friction && (friction.level === "critical" || friction.level === "high")) {
      recommendation = "resolve-issues";
      detail = strings.recFriction(friction.credits);
    } else if (vel.hasPattern && vel.urgency === "critical") {
      recommendation = "reactivate";
      detail = strings.recOverdue(vel.overdue, vel.cycle);
    } else if (churn.level === "critical" || churn.level === "high") {
      recommendation = "win-back";
      detail = strings.recWinBack;
    } else if (healthScore !== null && healthScore >= nurtureHealth && cmp(clv.clv, nurtureClvCut) >= 0) {
      recommendation = "nurture";
      detail = strings.recNurture;
    } else if (rfm.segment === "new") {
      recommendation = "onboard";
      detail = strings.recOnboard;
    } else if (leakMargin !== null) {
      recommendation = "reprice";
      detail = strings.recReprice(leakMargin.toFixed(1));
    } else if (healthScore === null || healthScore < gradeD) {
      // The review floor follows the shared grade ladder (below D), and an
      // unscored customer — no term left to score — lands here too.
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
      yoyPct: yoyOf(c.revenue, c.priorRevenue),
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
      creditValue: friction?.creditValue ?? "0",
      returnRate: friction?.returnRate ?? 0,
      avgOrderCycle: vel.hasPattern ? vel.cycle : 0,
      daysOverdue: velOverdue,
      urgency: vel.hasPattern ? vel.urgency : "on-track",
      paymentScore: payment ? payment.score : null,
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
      scoredWithoutPayment,
      scoreBreakdown: { recency: recencyScore, frequency: frequencyScore, monetary: monetaryScore, payment: payment ? payment.score : null, frictionPenalty: -frictionPenalty },
    };
  });
  // Unscored customers sort last: no score is not the lowest score.
  rows.sort((a, b) => (b.healthScore ?? -1) - (a.healthScore ?? -1));

  /* ---- segments distribution ---- */
  const SEGMENTS: Segment[] = ["champions", "loyal", "potential", "new", "regular", "hibernating", "at-risk", "lost"];
  const segments: SegmentStat[] = SEGMENTS.map((segment) => {
    const set = rows.filter((r) => r.segment === segment);
    const rev = sum(set.map((r) => r.revenue));
    return {
      segment,
      count: set.length,
      percentage: rows.length ? Math.round((set.length / rows.length) * 100) : 0,
      totalRevenue: rev,
      avgRevenue: set.length ? div(rev, String(set.length)) : "0",
      totalInvoiced: sum(set.map((r) => r.invoicedRevenue)),
    };
  });

  /* ---- growth () ---- */
  // Monthly INVOICED revenue arrives per (month, functional, posting day):
  // translate each day at its own spot rate, then merge per month. Distinct
  // counts ride the separate month-grain query (they never merge across
  // functionals). The recognized monthly series is built from the ledger
  // legs just below.
  const gLegs = growthRows.rows as unknown as CustomerGrowthSqlRow[];
  const gCtx = await flowRates(orgId, gLegs.map((r) => ({
    func: r.func ?? null, date: String(r.day).slice(0, 10),
  })));
  const gRevenue = new Map<string, string>();
  for (const r of gLegs) {
    const key = String(r.month);
    gRevenue.set(key, add(gRevenue.get(key) ?? "0",
      mulDecimal(String(r.revenue ?? 0), gCtx.rateAt(r.func ?? null, String(r.day).slice(0, 10)))));
  }
  interface GrowthCountRow { month: string; unique_customers: CustomerSqlNumeric; txn_count: CustomerSqlNumeric; new_customers: CustomerSqlNumeric }
  const gCounts = new Map<string, GrowthCountRow>();
  for (const r of growthCounts.rows as unknown as GrowthCountRow[]) {
    gCounts.set(String(r.month), r);
  }
  // Recognized monthly: same leg pattern over the ledger month query. Months
  // present in only one universe still appear (the other reads zero) so the
  // timing gap between billing and recognition stays visible month by month.
  interface GrowthLedgerRow { month: string; func: string | null; day: string; recognized: CustomerSqlNumeric }
  const glLegs = growthLedgerRows.rows as unknown as GrowthLedgerRow[];
  const glCtx = await flowRates(orgId, glLegs.map((r) => ({
    func: r.func ?? null, date: String(r.day).slice(0, 10),
  })));
  const gRecognized = new Map<string, string>();
  for (const r of glLegs) {
    const key = String(r.month);
    gRecognized.set(key, add(gRecognized.get(key) ?? "0",
      mulDecimal(String(r.recognized ?? 0), glCtx.rateAt(r.func ?? null, String(r.day).slice(0, 10)))));
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
  const revenues = gRows.map((r) => r.revenue).sort(cmp);
  const medianRevenue = revenues.length ? revenues[Math.floor(revenues.length / 2)]! : "0";
  const minRevenueThreshold = mulDecimal(medianRevenue, String(maturityFloor));
  let prevRevenue: string | null = null;
  const monthly: MonthlyGrowth[] = gRows.map((r) => {
    const revenue = r.revenue;
    const isMature = cmp(revenue, minRevenueThreshold) >= 0;
    let growthRate: number | null = 0;
    if (prevRevenue !== null && cmp(prevRevenue, minRevenueThreshold) > 0) {
      const rateText = evaluateAnalyticsRatio(add(revenue, neg(prevRevenue)), prevRevenue, "percent", 1);
      growthRate = rateText === null ? 0 : Number(rateText);
      if (growthRate > momCapUp) growthRate = momCapUp;
      if (growthRate < -momCapDown) growthRate = -momCapDown;
    } else if (prevRevenue !== null && cmp(prevRevenue, "0") > 0 && cmp(revenue, minRevenueThreshold) > 0) {
      growthRate = null; // ramp-up period
    }
    prevRevenue = revenue;
    return {
      month: r.month,
      label: strings.monthLabel(r.month),
      revenue,
      invoiced: r.invoiced,
      uniqueCustomers: Number(r.counts?.unique_customers ?? 0),
      transactionCount: Number(r.counts?.txn_count ?? 0),
      newCustomers: Number(r.counts?.new_customers ?? 0),
      growthRate,
      isMature,
    };
  });
  if (preview) return {
    kpis: {
      totalCustomers: base.length,
      totalRevenue: totalRevenueExact,
      totalInvoiced: totalInvoicedExact,
      atRiskCount: base.filter((customer) => ["critical", "high"].includes(churnOf(customer).level)).length,
    },
    growth: { monthly },
  };
  // The metric-only preview above deliberately skips payment statistics.
  // The full dashboard uses the canonical engine DSO, while customer rows
  // retain their own days-to-pay detail.
  if (dsoStats === null) throw new Error(strings.paymentStatsUnavailable());
  const avgDaysToPay = dsoStats.globalAvg;

  let yoyGrowth: number | null = null;
  if (monthly.length >= yoyWindow) {
    const recent3 = sum(monthly.slice(-3).map((m) => m.revenue));
    const prior3 = sum(monthly.slice(-yoyWindow, -(yoyWindow - 3)).map((m) => m.revenue));
    if (cmp(prior3, minRevenueThreshold) > 0) {
      const yoyText = evaluateAnalyticsRatio(add(recent3, neg(prior3)), prior3, "percent", 0);
      yoyGrowth = yoyText === null ? null : Number(yoyText);
    }
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
    // Both windows share their size, so comparing sums compares averages.
    const recentSum = sum(recentWindow.map((m) => m.revenue));
    const priorSum = sum(priorWindow.map((m) => m.revenue));
    const trendText = cmp(priorSum, "0") > 0
      ? evaluateAnalyticsRatio(add(recentSum, neg(priorSum)), priorSum, "percent", 2)
      : null;
    const pct = trendText === null ? 0 : Number(trendText);
    if (pct > trendBand) trend = "growing";
    else if (pct < -trendBand) trend = "declining";
  }
  const totalNewCustomers = monthly.reduce((a, m) => a + m.newCustomers, 0);

  /* ---- cohorts () ---- */
  // Month arithmetic clamps instead of overflowing (Aug 31 minus six months
  // is Feb 28/29, never Mar 3): addMonthsClamped carries the civil calendar.
  const activeCut = addMonthsClamped(ref, -6).slice(0, 10);
  // Lifetime INVOICED revenue arrives per (party, functional, posting day):
  // translate each day at its own spot rate, merge per party, then run the
  // cohort logic on parties (never on legs). Lifetime recognized merges in
  // from the ledger legs just below; cohort membership (first/last year)
  // stays document-based.
  interface CohortLeg { id: string; func: string | null; day: string; first_order: unknown; last_order: unknown; lifetime_revenue: CustomerSqlNumeric }
  const cohortLegs = cohortRows.rows as unknown as CohortLeg[];
  const cohortCtx = await flowRates(orgId, cohortLegs.map((r) => ({
    func: r.func ?? null, date: String(r.day).slice(0, 10),
  })));
  const cohortByParty = new Map<string, { first: string; last: string; revenue: string; invoiced: string }>();
  for (const r of cohortLegs) {
    const first = String(r.first_order).slice(0, 10);
    const last = String(r.last_order).slice(0, 10);
    const cur = cohortByParty.get(r.id) ?? { first, last, revenue: "0", invoiced: "0" };
    if (first < cur.first) cur.first = first;
    if (last > cur.last) cur.last = last;
    cur.invoiced = add(cur.invoiced, mulDecimal(String(r.lifetime_revenue ?? 0),
      cohortCtx.rateAt(r.func ?? null, String(r.day).slice(0, 10))));
    cohortByParty.set(r.id, cur);
  }
  interface CohortLedgerLeg { id: string; func: string | null; day: string; recognized: CustomerSqlNumeric }
  const cohortLedgerLegs = cohortLedgerRows.rows as unknown as CohortLedgerLeg[];
  const cohortLedgerCtx = await flowRates(orgId, cohortLedgerLegs.map((r) => ({
    func: r.func ?? null, date: String(r.day).slice(0, 10),
  })));
  for (const r of cohortLedgerLegs) {
    const cur = cohortByParty.get(r.id);
    // Recognition without any invoice history has no cohort to join (cohorts
    // are billing relationships by first-order year) — the org-level P&L tie
    // still counts it, so no money is lost, only uncohortable.
    if (!cur) continue;
    cur.revenue = add(cur.revenue, mulDecimal(String(r.recognized ?? 0),
      cohortLedgerCtx.rateAt(r.func ?? null, String(r.day).slice(0, 10))));
  }
  const cohortMap = new Map<string, Cohort>();
  let lifetimeCustomers = 0, lifetimeActive = 0;
  for (const p of cohortByParty.values()) {
    const year = p.first.slice(0, 4);
    const isActive = p.last >= activeCut;
    lifetimeCustomers++;
    if (isActive) lifetimeActive++;
    let c = cohortMap.get(year);
    if (!c) { c = { year, totalCustomers: 0, activeCustomers: 0, retentionRate: 0, totalRevenue: "0", avgRevenue: "0", totalInvoiced: "0" }; cohortMap.set(year, c); }
    c.totalCustomers++;
    if (isActive) c.activeCustomers++;
    c.totalRevenue = add(c.totalRevenue, p.revenue);
    c.totalInvoiced = add(c.totalInvoiced, p.invoiced);
  }
  const cohortList = [...cohortMap.values()]
    .map((c) => ({
      ...c,
      retentionRate: c.totalCustomers ? Math.round((c.activeCustomers / c.totalCustomers) * 100) : 0,
      avgRevenue: c.totalCustomers ? div(c.totalRevenue, String(c.totalCustomers)) : "0",
      totalRevenue: c.totalRevenue,
      totalInvoiced: c.totalInvoiced,
    }))
    .sort((a, b) => a.year.localeCompare(b.year));
  const overallRetention = lifetimeCustomers ? Math.round((lifetimeActive / lifetimeCustomers) * 100) : 0;

  /* ---- intelligence score () ---- */
  const championsStat = segments.find((s) => s.segment === "champions")!;
  const championsScore = Math.min(100, championsStat.percentage * 5);
  // Terms with no data are dropped and the remaining weights re-normalised:
  // with no scored customers there is no average retention, and with no
  // invoices there is no payment rate — neither reads as a number.
  const avgRetentionProbability = rows.length
    ? Math.round(rows.reduce((a, r) => a + r.retentionProbability, 0) / rows.length)
    : null;
  const concentrationHealth = hhiLevel === "high" ? 30 : hhiLevel === "moderate" ? 60 : 90;
  const intelTerms: { value: number; weight: number }[] = [{ value: championsScore, weight: intelChampions }];
  if (avgRetentionProbability !== null) intelTerms.push({ value: avgRetentionProbability, weight: intelRetention });
  intelTerms.push({ value: concentrationHealth, weight: intelConcentration });
  if (paymentRate !== null) intelTerms.push({ value: paymentRate, weight: intelPayment });
  // Terms with no data stay out; when no weighted term is left the portfolio
  // has no intelligence score — null with a named remedy, never a 0 that
  // reads as "scored worst".
  const intelligenceScore = compositeScoreOf(intelTerms);
  const intelligence: CustomerData["intelligence"] = intelligenceScore === null
    ? { score: null, reason: strings.intelligenceUnavailable() }
    : {
      score: intelligenceScore,
      ...strings.intelligenceScore(intelligenceScore, {
        aPlus: gradeAPlus, a: gradeA, b: gradeB, c: gradeC, d: gradeD,
      }),
    };

  /* ---- aggregates + insights ---- */
  const atRisk = rows.filter((r) => r.churnLevel === "critical" || r.churnLevel === "high");
  const atRiskRevenue = sum(atRisk.map((r) => r.revenue));
  const totalProjectedClv = sum(rows.map((r) => r.clv));
  const overdueOrders = rows.filter((r) => r.daysOverdue > 0).length;
  const topCustomerShare = byRevenue[0] ? shareMap.get(byRevenue[0].c.id)!.sharePct : 0;

  const insights: Insight[] = [];
  const fmtM = (n: string) => moneyCompact(n);
  if (cmp(totalProjectedClv, "0") > 0)
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
  if (totOverdue > overdueInsightAt)
    insights.push({ type: "warning", category: "payments", ...strings.overdue(totOverdue), impact: "medium" });

  const TIERS: Tier[] = ["platinum", "gold", "silver", "bronze"];
  return {
    period,
    rows,
    intelligence,
    kpis: {
      totalCustomers: rows.length,
      totalRevenue: totalRevenueExact,
      totalInvoiced: totalInvoicedExact,
      avgCustomerValue: rows.length ? div(totalRevenueExact, String(rows.length)) : "0",
      projectedClv: totalProjectedClv,
      avgClv: rows.length ? div(totalProjectedClv, String(rows.length)) : "0",
      champions: championsStat.count,
      atRiskCount: atRisk.length,
      atRiskRevenue,
      retentionRate: avgRetentionProbability,
      paymentRate,
      avgDaysToPay,
      top10PctShare: top10Share,
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
      fakeChampions: profitData?.summary.fakeChampions ?? null,
    },
    segments,
    tierBreakdown: TIERS.map((tier) => {
      const set = rows.filter((r) => r.tier === tier);
      return { tier, count: set.length, revenue: sum(set.map((r) => r.revenue)), invoiced: sum(set.map((r) => r.invoicedRevenue)), threshold: tierThresholds[tier] };
    }),
    growth: { monthly, yoyGrowth, avgMonthlyGrowth, medianMonthlyRevenue: medianRevenue, totalNewCustomers, trend },
    cohorts: { list: cohortList, overallRetention },
    insights,
    config: cfg,
  };
}
