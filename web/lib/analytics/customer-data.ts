import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

/**
 * Customer Intelligence — the data behind /analytics/customer-intelligence,
 * ported from Gantry's Revenue Intelligence (CustomerValue) dashboard. Sourced
 * natively: customer revenue from GL income lines by party, invoice cadence
 * from customer_invoice documents, and project-rolled profitability via
 * projects.customer_id. RFM, tiers, CLV and churn are derived here.
 */

export type Tier = "platinum" | "gold" | "silver" | "bronze";
export type ChurnBand = "healthy" | "watch" | "at_risk" | "churned";

export interface CustomerRow {
  id: string;
  name: string;
  revenue: number;
  priorRevenue: number;
  yoyPct: number | null;
  sharePct: number;
  invoices: number;
  firstInvoice: string | null;
  lastInvoice: string | null;
  recencyDays: number | null;
  avgInvoice: number;
  tier: Tier;
  // profitability (project-rolled; null when the customer has no project-tagged activity)
  cost: number | null;
  profit: number | null;
  marginPct: number | null;
  jobs: number;
  // derived scores
  rfm: { r: number; f: number; m: number; score: number };
  clv: number; // projected 3-year value
  churn: ChurnBand;
}

export interface CustomerData {
  period: { from: string; to: string; label: string };
  rows: CustomerRow[];
  totals: {
    customers: number;
    revenue: number;
    priorRevenue: number;
    yoyPct: number | null;
    cost: number;
    profit: number;
    marginPct: number | null;
    jobs: number;
    champions: number; // top-tier customers
    atRisk: number;
    atRiskRevenue: number;
    projectedClv: number;
    hhi: number; // concentration index 0..1
    top5SharePct: number;
    healthScore: number; // 0..100 blend of count- and revenue-weighted retention
  };
  tierBreakdown: { tier: Tier; count: number; revenue: number }[];
  churnBreakdown: { band: ChurnBand; count: number; revenue: number }[];
}

/* ------------------------------------------------------------ Profitability */
// Project-financials profitability, ported identically from Gantry's Revenue
// Intelligence "Profitability" tab: per-job (project) revenue/costs/profit
// rolled up to per-customer, with margin-based profit tiers.

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
  jobs: ProfitJob[];
}

export interface ProfitabilitySummary {
  totalRevenue: number;
  totalCost: number;
  totalGrossProfit: number;
  avgMarginPct: number;
  customerCount: number;
  totalJobs: number;
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

export async function customerProfitability(period: { from: string; to: string }): Promise<Profitability> {
  const { from, to } = period;
  const r = (await db.execute(sql`
    select pr.customer_id as customer_id,
      coalesce(cp.display_name, 'Unknown') as customer_name,
      pr.id as job_id,
      coalesce(pr.name, 'Untitled project') as job_name,
      -sum(case when a.type in ('income','income_other') then l.amount else 0 end) as revenue,
      sum(case when a.type in ('cogs','expense','expense_deferred') then l.amount else 0 end) as costs,
      count(distinct e.id) as txns
    from journal_lines l
    join accounts a on a.id = l.account_id
    join journal_entries e on e.id = l.entry_id
    join projects pr on pr.id = l.project_id
    join parties cp on cp.id = pr.customer_id
    where a.type in ('income','income_other','cogs','expense','expense_deferred')
      and l.project_id is not null and pr.customer_id is not null
      and e.posting_date >= ${from} and e.posting_date <= ${to}
    group by pr.customer_id, cp.display_name, pr.id, pr.name
  `)) as any;

  const byCustomer = new Map<string, ProfitCustomer>();
  for (const row of r.rows as any[]) {
    const revenue = Number(row.revenue);
    const costs = Number(row.costs);
    const profit = revenue - costs;
    // Skip empty projects (no revenue and no cost).
    if (Math.abs(revenue) < 0.005 && Math.abs(costs) < 0.005) continue;
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
      c = { customerId: row.customer_id, customerName: row.customer_name, totalRevenue: 0, totalCost: 0, grossProfit: 0, marginPct: 0, profitTier: "marginal", jobs: [] };
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
      tierBreakdown,
    },
  };
}

function priorYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000);
}

/** Quartile-based percentile rank → 1..5 score. */
function scoreByRank(index: number, total: number): number {
  if (total <= 1) return 5;
  const pct = 1 - index / (total - 1); // index 0 = best
  return Math.max(1, Math.min(5, Math.ceil(pct * 5)));
}

export async function customerData(period: { from: string; to: string; label: string }): Promise<CustomerData> {
  const { from, to } = period;
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  // Recency is "days since last order" as of NOW — never the period's future
  // end date (the current fiscal year hasn't ended yet), else every customer
  // reads as churned. Clamp the reference to today.
  const today = new Date().toISOString().slice(0, 10);
  const ref = to < today ? to : today;

  const [revRows, invRows, profRows] = await Promise.all([
    // Revenue by customer party (current + prior year), from GL income lines.
    db.execute(sql`
      select p.id, coalesce(p.display_name, 'Unknown') as name,
        -sum(case when e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as revenue,
        -sum(case when e.posting_date >= ${pFrom} and e.posting_date <= ${pTo} then l.amount else 0 end) as prior_revenue
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      join parties p on p.id = l.party_id
      where a.type in ('income', 'income_other') and l.party_id is not null
        and e.posting_date >= ${pFrom} and e.posting_date <= ${to}
      group by p.id, p.display_name
    `) as Promise<any>,
    // Invoice cadence over the customer's LIFETIME up to the reference date, so
    // recency/frequency reflect true ordering behaviour (a customer who last
    // ordered 8 months ago must read as at-risk, not "recent").
    db.execute(sql`
      select party_id as id, count(*) as invoices,
        min(posting_date) as first_invoice, max(posting_date) as last_invoice
      from documents
      where kind = 'customer_invoice' and party_id is not null and status = 'posted'
        and posting_date <= ${ref}
      group by party_id
    `) as Promise<any>,
    // Project-rolled profitability by customer (jobs = distinct projects).
    db.execute(sql`
      select pr.customer_id as id,
        -sum(case when a.type in ('income','income_other') then l.amount else 0 end) as revenue,
        sum(case when a.type = 'cogs' then l.amount else 0 end) as cogs,
        sum(case when a.type in ('expense','expense_deferred') then l.amount else 0 end) as opex,
        count(distinct l.project_id) as jobs
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      join projects pr on pr.id = l.project_id
      where a.type in ('income','income_other','cogs','expense','expense_deferred')
        and pr.customer_id is not null and l.project_id is not null
        and e.posting_date >= ${from} and e.posting_date <= ${to}
      group by pr.customer_id
    `) as Promise<any>,
  ]);

  const inv = new Map<string, any>((invRows.rows as any[]).map((r) => [r.id, r]));
  const prof = new Map<string, any>((profRows.rows as any[]).map((r) => [r.id, r]));

  let base = (revRows.rows as any[])
    .map((r) => {
      const revenue = Number(r.revenue);
      const priorRevenue = Number(r.prior_revenue);
      const iv = inv.get(r.id);
      const pf = prof.get(r.id);
      const invoices = iv ? Number(iv.invoices) : 0;
      const lastInvoice = iv?.last_invoice ?? null;
      const firstInvoice = iv?.first_invoice ?? null;
      const cost = pf ? Number(pf.cogs) + Number(pf.opex) : null;
      const profJobs = pf ? Number(pf.jobs) : 0;
      const profRev = pf ? Number(pf.revenue) : 0;
      const profit = cost !== null ? profRev - cost : null;
      return {
        id: r.id as string,
        name: r.name as string,
        revenue,
        priorRevenue,
        yoyPct: priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue : null,
        invoices,
        firstInvoice,
        lastInvoice,
        recencyDays: lastInvoice ? daysBetween(lastInvoice, ref) : null,
        avgInvoice: invoices > 0 ? revenue / invoices : 0,
        cost,
        profit,
        marginPct: profit !== null && profRev > 0 ? profit / profRev : null,
        jobs: profJobs,
      };
    })
    .filter((r) => r.revenue > 0.005 || r.priorRevenue > 0.005);

  base.sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = base.reduce((a, r) => a + r.revenue, 0) || 1;

  // RFM: rank recency (lower days = better), frequency (invoices), monetary (revenue).
  const byRecency = [...base].sort((a, b) => (a.recencyDays ?? 1e9) - (b.recencyDays ?? 1e9));
  const byFreq = [...base].sort((a, b) => b.invoices - a.invoices);
  const byMon = [...base].sort((a, b) => b.revenue - a.revenue);
  const rIdx = new Map(byRecency.map((r, i) => [r.id, i]));
  const fIdx = new Map(byFreq.map((r, i) => [r.id, i]));
  const mIdx = new Map(byMon.map((r, i) => [r.id, i]));
  const n = base.length;

  const rows: CustomerRow[] = base.map((r, i) => {
    const rScore = scoreByRank(rIdx.get(r.id)!, n);
    const fScore = scoreByRank(fIdx.get(r.id)!, n);
    const mScore = scoreByRank(mIdx.get(r.id)!, n);
    const rfmScore = rScore + fScore + mScore;
    // Tier by monetary rank.
    const tier: Tier = i < n * 0.1 ? "platinum" : i < n * 0.3 ? "gold" : i < n * 0.6 ? "silver" : "bronze";
    // CLV: annualized revenue × expected 3-year retention, discounted by RFM.
    const annual = r.revenue; // period ≈ a year for FY presets
    const clv = annual * 3 * (0.6 + (rfmScore / 15) * 0.6);
    // Churn by recency vs a 120-day cadence heuristic.
    const churn: ChurnBand =
      r.recencyDays === null ? "watch"
      : r.recencyDays <= 60 ? "healthy"
      : r.recencyDays <= 120 ? "watch"
      : r.recencyDays <= 240 ? "at_risk"
      : "churned";
    return {
      ...r,
      sharePct: r.revenue / totalRevenue,
      tier,
      rfm: { r: rScore, f: fScore, m: mScore, score: rfmScore },
      clv,
      churn,
    };
  });

  // Aggregates
  const withProfit = rows.filter((r) => r.profit !== null);
  const totalCost = withProfit.reduce((a, r) => a + (r.cost ?? 0), 0);
  const totalProfit = withProfit.reduce((a, r) => a + (r.profit ?? 0), 0);
  const profRevenue = withProfit.reduce((a, r) => a + r.revenue, 0);
  const priorRevenue = rows.reduce((a, r) => a + r.priorRevenue, 0);
  const revenue = rows.reduce((a, r) => a + r.revenue, 0);
  const hhi = rows.reduce((a, r) => a + r.sharePct ** 2, 0);
  const top5 = rows.slice(0, 5).reduce((a, r) => a + r.revenue, 0);
  const atRiskRows = rows.filter((r) => r.churn === "at_risk" || r.churn === "churned");
  const retainedRows = rows.filter((r) => r.churn === "healthy" || r.churn === "watch");
  const retainedRevenue = retainedRows.reduce((a, r) => a + r.revenue, 0);
  const healthScore = rows.length
    ? (0.5 * (retainedRows.length / rows.length) + 0.5 * (revenue > 0 ? retainedRevenue / revenue : 0)) * 100
    : 0;

  const tiers: Tier[] = ["platinum", "gold", "silver", "bronze"];
  const bands: ChurnBand[] = ["healthy", "watch", "at_risk", "churned"];

  return {
    period,
    rows,
    totals: {
      customers: rows.length,
      revenue,
      priorRevenue,
      yoyPct: priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue : null,
      cost: totalCost,
      profit: totalProfit,
      marginPct: profRevenue > 0 ? totalProfit / profRevenue : null,
      jobs: rows.reduce((a, r) => a + r.jobs, 0),
      champions: rows.filter((r) => r.tier === "platinum").length,
      atRisk: atRiskRows.length,
      atRiskRevenue: atRiskRows.reduce((a, r) => a + r.revenue, 0),
      projectedClv: rows.reduce((a, r) => a + r.clv, 0),
      hhi,
      top5SharePct: revenue > 0 ? top5 / revenue : 0,
      healthScore,
    },
    tierBreakdown: tiers.map((tier) => {
      const set = rows.filter((r) => r.tier === tier);
      return { tier, count: set.length, revenue: set.reduce((a, r) => a + r.revenue, 0) };
    }),
    churnBreakdown: bands.map((band) => {
      const set = rows.filter((r) => r.churn === band);
      return { band, count: set.length, revenue: set.reduce((a, r) => a + r.revenue, 0) };
    }),
  };
}
