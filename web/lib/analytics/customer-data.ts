import "server-only";
import { getMoneyFormatter } from '../money-server'
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { analyticsConfig } from "./config";

/**
 * Customer Intelligence — the data behind /analytics/customer-intelligence.
 * Every subsystem and its exact parameters:
 *  - Base metrics: per-customer invoice count / revenue / avg value / first-last
 *    dates / recency / tenure from customer_invoice documents.
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

export type Tier = "platinum" | "gold" | "silver" | "bronze";
export type Segment = "champions" | "loyal" | "potential" | "new" | "regular" | "hibernating" | "at-risk" | "lost";
export type RiskLevel = "critical" | "high" | "medium" | "low";
export type Recommendation = "resolve-issues" | "reactivate" | "win-back" | "nurture" | "onboard" | "reprice" | "review" | "maintain";

export interface CustomerRow {
  id: string;
  name: string;
  // base metrics
  revenue: number;
  priorRevenue: number;
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
  totalRevenue: number;
  avgRevenue: number;
}

export interface MonthlyGrowth {
  month: string;
  label: string;
  revenue: number;
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
  totalRevenue: number;
  avgRevenue: number;
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
    totalRevenue: number;
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
  tierBreakdown: { tier: Tier; count: number; revenue: number; threshold: number }[];
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

function profitTierOf(marginPct: number): ProfitTier {
  if (marginPct >= 40) return "high";
  if (marginPct >= 25) return "medium";
  if (marginPct >= 10) return "low";
  if (marginPct >= 0) return "marginal";
  return "loss";
}

export async function customerProfitability(period: { from: string; to: string }, orgId?: string): Promise<Profitability> {
  const { from, to } = period;
  const orgFilter = orgId ? sql`and l.org_id = ${orgId}` : sql``;
  // The entry window materializes first. Joined inline, the planner drives
  // from accounts and probes the entry primary key once per journal line in
  // the tenant before the date filter narrows anything.
  const r = (await db.execute(sql`
    with ew as materialized (
      select id from journal_entries
       where posting_date >= ${from} and posting_date <= ${to}
         ${orgId ? sql`and org_id = ${orgId}` : sql``}
    )
    select pr.customer_id as customer_id,
      coalesce(cp.display_name, 'Unknown') as customer_name,
      pr.id as job_id,
      coalesce(pr.name, 'Untitled project') as job_name,
      -sum(case when a.type in ('income','income_other') then l.amount else 0 end) as revenue,
      sum(case when a.type in ('cogs','expense','expense_deferred') then l.amount else 0 end) as costs,
      count(distinct e.id) as txns
    from ew e
    join journal_lines l on l.entry_id = e.id
    join accounts a on a.id = l.account_id
    join projects pr on pr.id = l.project_id
    join parties cp on cp.id = pr.customer_id
    where a.type in ('income','income_other','cogs','expense','expense_deferred')
      and l.project_id is not null and pr.customer_id is not null
      ${orgFilter}
    group by pr.customer_id, cp.display_name, pr.id, pr.name
  `)) as any;

  const byCustomer = new Map<string, ProfitCustomer>();
  for (const row of r.rows as any[]) {
    const revenue = Number(row.revenue);
    const costs = Number(row.costs);
    const profit = revenue - costs;
    // Skip empty projects (no revenue and no cost).
    if (revenue === 0 && costs === 0) continue;
    const job: ProfitJob = {
      jobId: row.job_id,
      jobName: row.job_name,
      revenue,
      costs,
      profit,
      marginPct: revenue > 0 ? (profit / revenue) * 100 : 0,
      transactionCount: Number(row.txns),
    };
    let c = byCustomer.get(row.customer_id);
    if (!c) {
      c = { customerId: row.customer_id, customerName: row.customer_name, totalRevenue: 0, totalCost: 0, grossProfit: 0, marginPct: 0, profitTier: "marginal", isFakeChampion: false, jobs: [] };
      byCustomer.set(row.customer_id, c);
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

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function priorYearIso(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y! - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------- main */
export async function customerData(period: { from: string; to: string; label: string }, orgId: string): Promise<CustomerData> {
  const { moneyCompact } = await getMoneyFormatter(orgId)
  const { from, to } = period;
  const pFrom = priorYearIso(from);
  const pTo = priorYearIso(to);
  // Recency/overdue are measured "as of now", never a future period end.
  const today = await businessToday(orgId);
  const ref = to < today ? to : today;

  // Per-org tunable thresholds (defaults reproduce the standard scoring exactly).
  const cfg = await analyticsConfig(orgId, "customerIntelligence");
  const churnCritical = cfg.churnCriticalScore;
  const churnHigh = cfg.churnHighScore;
  const churnMedium = cfg.churnMediumScore;
  const hhiWarning = cfg.hhiWarning;
  const hhiCritical = cfg.hhiCritical;
  const clvYears = cfg.clvYears;

  const [baseRows, frictionRows, paymentRows, growthRows, cohortRows, profitData] = await Promise.all([
    // Base customer metrics — the header query over CustInvc(+CashSale):
    // per-customer count / revenue / avg / first / last / recency / tenure.
    // Prior-year revenue added for YoY context (openbooks extension).
    db.execute(sql`
      select d.party_id as id, coalesce(p.display_name, 'Unknown') as name,
        count(*) filter (where d.posting_date >= ${from}) as txn_count,
        sum(abs(d.total)) filter (where d.posting_date >= ${from}) as revenue,
        avg(abs(d.total)) filter (where d.posting_date >= ${from}) as avg_value,
        sum(abs(d.total)) filter (where d.posting_date >= ${pFrom} and d.posting_date <= ${pTo}) as prior_revenue,
        min(d.posting_date) filter (where d.posting_date >= ${from}) as first_txn,
        max(d.posting_date) filter (where d.posting_date >= ${from}) as last_txn
      from documents d
      join parties p on p.id = d.party_id and p.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
        and d.voided_at is null and d.party_id is not null
        and d.posting_date >= ${pFrom} and d.posting_date <= ${to}
      group by d.party_id, p.display_name
      having sum(abs(d.total)) filter (where d.posting_date >= ${from}) > 0
    `) as Promise<any>,
    // Friction — credit memos per customer (returns×3 + credits×2;
    // this ledger has no return-auth kind, so returns are always 0).
    db.execute(sql`
      select d.party_id as id,
        count(*) filter (where d.kind = 'customer_credit') as credit_count,
        coalesce(sum(abs(d.total)) filter (where d.kind = 'customer_credit'), 0) as credit_value,
        count(*) filter (where d.kind = 'customer_invoice') as order_count
      from documents d
      where d.org_id = ${orgId} and d.kind in ('customer_credit', 'customer_invoice')
        and d.status = 'posted' and d.voided_at is null and d.party_id is not null
        and d.posting_date >= ${from} and d.posting_date <= ${to}
      group by d.party_id
      having count(*) filter (where d.kind = 'customer_invoice') > 0
    `) as Promise<any>,
    // Payment behaviour — paid = fully-applied invoice; days-to-pay = final
    // application date − invoice date; overdue =
    // past due and not fully paid, as of the reference date.
    db.execute(sql`
      with inv as (
        select d.id, d.party_id, d.posting_date, d.due_date, abs(d.total) as total,
          coalesce(sum(ap.amount), 0) as applied,
          max(pe.posting_date) as last_payment
        from documents d
        join journal_entries ie on ie.source_document_id = d.id
        join journal_lines il on il.entry_id = ie.id
        join accounts ia on ia.id = il.account_id and ia.type = 'asset_receivable'
        left join applications ap on ap.to_line_id = il.id and ap.unapplied_at is null
        left join journal_lines pl on pl.id = ap.from_line_id
        left join journal_entries pe on pe.id = pl.entry_id and pe.org_id = pl.org_id
        where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
          and d.voided_at is null and d.party_id is not null
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
    `) as Promise<any>,
    // Growth trends — monthly revenue / unique customers / txns / NEW customers
    // (no earlier customer doc of any kind, lifetime — the NOT EXISTS).
    // A customer is new in the month it first appears. Asking that as a
    // correlated NOT EXISTS re-scanned the document history once per invoice
    // in the window; each party's first month is computed once instead, which
    // is the same test — the invoice itself qualifies, so "no earlier document"
    // and "first document is this month" coincide.
    db.execute(sql`
      with first_doc as (
        select party_id, min(date_trunc('month', posting_date)) as first_month
          from documents
         where org_id = ${orgId} and kind in ('customer_invoice', 'sales_order')
           and voided_at is null and party_id is not null
         group by party_id
      )
      select to_char(d.posting_date, 'YYYY-MM') as month,
        count(distinct d.party_id) as unique_customers,
        count(*) as txn_count,
        sum(abs(d.total)) as revenue,
        count(distinct d.party_id) filter (
          where f.first_month = date_trunc('month', d.posting_date)) as new_customers
      from documents d
      join first_doc f on f.party_id = d.party_id
      where d.org_id = ${orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
        and d.voided_at is null and d.party_id is not null
        and d.posting_date >= ${from} and d.posting_date <= ${to}
      group by 1 order by 1
    `) as Promise<any>,
    // Cohorts — lifetime per-customer first/last order + lifetime revenue;
    // grouped into join-year cohorts below (active = ordered in last 6 months).
    db.execute(sql`
      select party_id as id, max(posting_date) as last_order, min(posting_date) as first_order,
        sum(abs(total)) as lifetime_revenue
      from documents
      where org_id = ${orgId} and kind = 'customer_invoice' and status = 'posted'
        and voided_at is null and party_id is not null
      group by party_id
    `) as Promise<any>,
    customerProfitability(period, orgId),
  ]);

  /* ---- base metrics ---- */
  interface Base {
    id: string; name: string; revenue: number; priorRevenue: number; txns: number;
    avgValue: number; first: string | null; last: string | null; recency: number; tenure: number;
  }
  const base: Base[] = (baseRows.rows as any[]).map((r) => {
    const last = r.last_txn ? String(r.last_txn) : null;
    const first = r.first_txn ? String(r.first_txn) : null;
    return {
      id: r.id,
      name: r.name,
      revenue: Number(r.revenue ?? 0),
      priorRevenue: Number(r.prior_revenue ?? 0),
      txns: Number(r.txn_count ?? 0),
      avgValue: Number(r.avg_value ?? 0),
      first,
      last,
      recency: last ? Math.max(0, daysBetween(last, ref)) : 9999,
      tenure: first && last ? daysBetween(first, last) : 0,
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
    if (c.recency > CHURN_HIGH_DAYS) { score += 40; factors.push(`No activity in ${c.recency} days`); }
    else if (c.recency > CHURN_MEDIUM_DAYS) { score += 25; factors.push("Declining engagement"); }
    else if (c.recency > 30) score += 10;
    const avgDaysBetween = c.tenure / Math.max(1, c.txns);
    if (c.recency > avgDaysBetween * 2) { score += 30; factors.push("Below typical purchase pattern"); }
    else if (c.recency > avgDaysBetween * 1.5) score += 15;
    if (c.txns <= 1) { score += 30; factors.push("Single transaction customer"); }
    else if (c.txns <= 3) { score += 15; factors.push("Low transaction frequency"); }
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
  const frictionMap = new Map<string, { points: number; level: RiskLevel; credits: number; creditValue: number; returnRate: number }>();
  for (const r of frictionRows.rows as any[]) {
    const credits = Number(r.credit_count ?? 0);
    const orders = Number(r.order_count ?? 0);
    const points = credits * 2; // returns×3 unavailable — no return-auth kind
    const returnRate = orders > 0 ? (credits / orders) * 100 : 0;
    let level: RiskLevel = "low";
    if (points >= 10 || returnRate >= 20) level = "critical";
    else if (points >= 5 || returnRate >= 10) level = "high";
    else if (points >= 2 || returnRate >= 5) level = "medium";
    if (points > 0) frictionMap.set(r.id, { points, level, credits, creditValue: Math.round(Number(r.credit_value ?? 0)), returnRate: Math.round(returnRate * 10) / 10 });
  }

  const paymentMap = new Map<string, { score: number; rating: CustomerRow["paymentRating"]; avgDays: number | null; overdue: number; rate: number }>();
  let totInvoices = 0, totPaid = 0, totOverdue = 0;
  for (const r of paymentRows.rows as any[]) {
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
  const payersWithDays = [...paymentMap.values()].filter((p) => p.avgDays !== null);
  const avgDaysToPay = payersWithDays.length ? Math.round(payersWithDays.reduce((a, p) => a + (p.avgDays ?? 0), 0) / payersWithDays.length) : 0;

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
    let detail = "Continue current engagement strategy";
    const velOverdue = vel.hasPattern ? vel.overdue : 0;
    if (friction && (friction.level === "critical" || friction.level === "high")) {
      recommendation = "resolve-issues";
      detail = `High friction: ${friction.credits} credits — address issues immediately`;
    } else if (vel.hasPattern && vel.urgency === "critical") {
      recommendation = "reactivate";
      detail = `${vel.overdue} days overdue for order (avg cycle: ${vel.cycle} days)`;
    } else if (churn.level === "critical" || churn.level === "high") {
      recommendation = "win-back";
      detail = "At risk of churn — immediate outreach needed";
    } else if (healthScore >= 85 && clv.clv > 10_000) {
      recommendation = "nurture";
      detail = "High-value customer — prioritize relationship";
    } else if (rfm.segment === "new") {
      recommendation = "onboard";
      detail = "New customer — focus on successful onboarding";
    } else if (profit?.isFakeChampion) {
      recommendation = "reprice";
      detail = `High revenue but low margin (${profit.marginPct.toFixed(1)}%) — review pricing`;
    } else if (healthScore < 50) {
      recommendation = "review";
      detail = "Low engagement — evaluate account strategy";
    }

    return {
      id: c.id,
      name: c.name,
      revenue: c.revenue,
      priorRevenue: c.priorRevenue,
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
    };
  });

  /* ---- growth () ---- */
  const gRows = growthRows.rows as any[];
  const revenues = gRows.map((r) => Number(r.revenue ?? 0)).sort((a, b) => a - b);
  const medianRevenue = revenues.length ? revenues[Math.floor(revenues.length / 2)]! : 0;
  const minRevenueThreshold = medianRevenue * 0.1;
  let prevRevenue: number | null = null;
  const monthly: MonthlyGrowth[] = gRows.map((r) => {
    const revenue = Number(r.revenue ?? 0);
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
      label: monthLabel(r.month),
      revenue: Math.round(revenue),
      uniqueCustomers: Number(r.unique_customers ?? 0),
      transactionCount: Number(r.txn_count ?? 0),
      newCustomers: Number(r.new_customers ?? 0),
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
    const recent6 = monthly.slice(-6).reduce((a, m) => a + m.revenue, 0) / 6;
    const prior6Set = monthly.length >= 12 ? monthly.slice(-12, -6) : monthly.slice(0, Math.min(6, monthly.length));
    const prior6 = prior6Set.reduce((a, m) => a + m.revenue, 0) / prior6Set.length;
    const pct = prior6 > 0 ? ((recent6 - prior6) / prior6) * 100 : 0;
    if (pct > 10) trend = "growing";
    else if (pct < -10) trend = "declining";
  }
  const totalNewCustomers = monthly.reduce((a, m) => a + m.newCustomers, 0);

  /* ---- cohorts () ---- */
  const sixMonthsAgo = new Date(ref + "T00:00:00Z");
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const activeCut = sixMonthsAgo.toISOString().slice(0, 10);
  const cohortMap = new Map<string, Cohort>();
  let lifetimeCustomers = 0, lifetimeActive = 0;
  for (const r of cohortRows.rows as any[]) {
    const year = String(r.first_order).slice(0, 4);
    const isActive = String(r.last_order) >= activeCut;
    lifetimeCustomers++;
    if (isActive) lifetimeActive++;
    let c = cohortMap.get(year);
    if (!c) { c = { year, totalCustomers: 0, activeCustomers: 0, retentionRate: 0, totalRevenue: 0, avgRevenue: 0 }; cohortMap.set(year, c); }
    c.totalCustomers++;
    if (isActive) c.activeCustomers++;
    c.totalRevenue += Number(r.lifetime_revenue ?? 0);
  }
  const cohortList = [...cohortMap.values()]
    .map((c) => ({
      ...c,
      retentionRate: c.totalCustomers ? Math.round((c.activeCustomers / c.totalCustomers) * 100) : 0,
      avgRevenue: c.totalCustomers ? Math.round(c.totalRevenue / c.totalCustomers) : 0,
      totalRevenue: Math.round(c.totalRevenue),
    }))
    .sort((a, b) => a.year.localeCompare(b.year));
  const overallRetention = lifetimeCustomers ? Math.round((lifetimeActive / lifetimeCustomers) * 100) : 0;

  /* ---- intelligence score () ---- */
  const championsStat = segments.find((s) => s.segment === "champions")!;
  const championsScore = Math.min(100, championsStat.percentage * 5);
  const avgRetentionProbability = rows.length ? Math.round(rows.reduce((a, r) => a + r.retentionProbability, 0) / rows.length) : 50;
  const concentrationHealth = hhiLevel === "high" ? 30 : hhiLevel === "moderate" ? 60 : 90;
  const intelligenceScore = Math.round(championsScore * 0.3 + avgRetentionProbability * 0.3 + concentrationHealth * 0.2 + paymentRate * 0.2);
  let scoreLabel = "Excellent", scoreGrade = "A";
  if (intelligenceScore < 40) { scoreLabel = "Needs Attention"; scoreGrade = "D"; }
  else if (intelligenceScore < 55) { scoreLabel = "Fair"; scoreGrade = "C"; }
  else if (intelligenceScore < 70) { scoreLabel = "Good"; scoreGrade = "B"; }
  else if (intelligenceScore < 85) { scoreLabel = "Very Good"; scoreGrade = "B+"; }

  /* ---- aggregates + insights ---- */
  const atRisk = rows.filter((r) => r.churnLevel === "critical" || r.churnLevel === "high");
  const atRiskRevenue = Math.round(atRisk.reduce((a, r) => a + r.revenue, 0));
  const totalProjectedClv = rows.reduce((a, r) => a + r.clv, 0);
  const overdueOrders = rows.filter((r) => r.daysOverdue > 0).length;
  const topCustomerShare = byRevenue[0] ? shareMap.get(byRevenue[0].c.id)!.sharePct : 0;

  const insights: Insight[] = [];
  const fmtM = (n: number) => moneyCompact(n);
  if (totalProjectedClv > 0)
    insights.push({ type: "info", category: "lifetime-value", title: "Projected Customer Value", message: `${fmtM(totalProjectedClv)} projected CLV over ${clvYears} years from ${rows.length} customers`, impact: "high" });
  if (atRisk.length > 0)
    insights.push({ type: "warning", category: "churn", title: "Churn Risk Alert", message: `${atRisk.length} customers at high/critical churn risk representing ${fmtM(atRiskRevenue)} revenue`, impact: "high", action: "Initiate win-back campaigns for at-risk customers" });
  if (championsStat.count > 0)
    insights.push({ type: "success", category: "segmentation", title: "Champion Customers", message: `${championsStat.count} champion customers generating ${fmtM(championsStat.totalRevenue)}`, impact: "high", action: "Maintain VIP treatment and referral programs" });
  if (hhiLevel === "high")
    insights.push({ type: "alert", category: "concentration", title: "Revenue Concentration Risk", message: `Top customer accounts for ${topCustomerShare.toFixed(1)}% of revenue. HHI: ${hhiScaled}`, impact: "high", action: "Diversify customer base to reduce dependency" });
  if (trend === "declining")
    insights.push({ type: "warning", category: "growth", title: "Declining Revenue Trend", message: `Average monthly growth of ${avgMonthlyGrowth}%`, impact: "high", action: "Review customer acquisition and retention strategies" });
  else if (trend === "growing")
    insights.push({ type: "success", category: "growth", title: "Strong Growth Trajectory", message: `${avgMonthlyGrowth}% average monthly growth with ${totalNewCustomers} new customers`, impact: "medium" });
  if (totOverdue > 5)
    insights.push({ type: "warning", category: "payments", title: "Overdue Invoices", message: `${totOverdue} overdue invoices require attention`, impact: "medium", action: "Review collections process and payment terms" });

  const TIERS: Tier[] = ["platinum", "gold", "silver", "bronze"];
  return {
    period,
    rows,
    intelligence: { score: intelligenceScore, label: scoreLabel, grade: scoreGrade },
    kpis: {
      totalCustomers: rows.length,
      totalRevenue: Math.round(totalRevenue),
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
      return { tier, count: set.length, revenue: set.reduce((a, r) => a + r.revenue, 0), threshold: tierThresholds[tier] };
    }),
    growth: { monthly, yoyGrowth, avgMonthlyGrowth, medianMonthlyRevenue: Math.round(medianRevenue), totalNewCustomers, trend },
    cohorts: { list: cohortList, overallRetention },
    insights,
    config: { churnCriticalScore: churnCritical, churnHighScore: churnHigh, churnMediumScore: churnMedium, hhiWarning, hhiCritical, clvYears },
  };
}
