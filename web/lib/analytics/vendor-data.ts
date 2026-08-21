import "server-only";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";

/**
 * Vendor Performance — data behind /analytics/vendor-performance.
 *
 * What openbooks' data supports (built): spend analysis, concentration (HHI),
 * spend tiers, PAYMENT BEHAVIOR (days-to-pay / on-time %, from the `applications`
 * ledger), a composite vendor SCORECARD, and a Kraljic-style LEVERAGE MATRIX.
 *
 * Unsupported metrics (because there is no PO↔bill line linkage and
 * `quantity_fulfilled`/`quantity_billed`/`billed_by_line_id` are all empty, and
 * bill lines carry no item_id): OTIF, Lead Time, Purchase Price Variance, and
 * Maverick spend. Those need receipt/fulfillment + PO-matching data that isn't
 * captured here — surfaced honestly in the UI rather than faked.
 */

export type SpendTier = "strategic" | "core" | "tactical" | "tail";
export type Grade = "A" | "B" | "C" | "D" | "F";
// Leverage matrix: spend (financial impact) × performance. We proxy
// "performance" with payment-relationship health (on-time %), the only vendor-
// performance signal this ledger supports.
export type Quadrant = "strategic" | "commodity" | "niche" | "transactional";

export interface VendorRow {
  id: string;
  name: string;
  spend: number;
  priorSpend: number;
  yoyPct: number | null;
  sharePct: number;
  bills: number;
  avgBill: number;
  lastBill: string | null;
  recencyDays: number | null;
  tier: SpendTier;
  // payment behaviour (how we pay this vendor)
  paidBills: number;
  avgDaysToPay: number | null;
  onTimePct: number | null;
  latePct: number | null;
  lateSpend: number;
  // derived scores
  score: number; // 0–100 relationship scorecard
  grade: Grade;
  performance: number; // 0–100 payment-relationship health (matrix Y axis)
  quadrant: Quadrant;
}

export interface MonthSpend {
  month: string;
  label: string;
  spend: number;
}

export interface VendorData {
  period: { from: string; to: string; label: string };
  rows: VendorRow[];
  monthly: MonthSpend[];
  totals: {
    vendors: number;
    spend: number;
    priorSpend: number;
    yoyPct: number | null;
    bills: number;
    avgBill: number;
    top5SharePct: number;
    top10SharePct: number;
    hhi: number;
    hhiScaled: number; // 0–10000 (the classic HHI scale)
    strategic: number;
    onTimePct: number | null;
    avgDaysToPay: number | null;
    lateSpend: number;
  };
  tierBreakdown: { tier: SpendTier; count: number; spend: number }[];
  gradeBreakdown: { grade: Grade; count: number; spend: number }[];
  quadrantBreakdown: { quadrant: Quadrant; count: number; spend: number }[];
}

function priorYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000);
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} '${String(y).slice(2)}`;
}
function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}
function gradeOf(score: number): Grade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export async function vendorData(
  period: { from: string; to: string; label: string },
  orgId: string,
): Promise<VendorData> {
  const { from, to } = period;
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  const today = await businessToday(orgId);
  const ref = to < today ? to : today;
  const end = new Date(to + "T00:00:00Z");
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const startIso = start.toISOString().slice(0, 10);

  const [spendRows, billRows, monthRows, payRows] = await Promise.all([
    // Entry window first: joined inline the planner drives from accounts and
    // probes the entry primary key once per journal line in the tenant.
    db.execute(sql`
      with ew as materialized (
        select id, posting_date from journal_entries
         where org_id = ${orgId} and posting_date >= ${pFrom} and posting_date <= ${to}
      )
      select p.id, coalesce(p.display_name, 'Unknown') as name,
        sum(case when e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as spend,
        sum(case when e.posting_date >= ${pFrom} and e.posting_date <= ${pTo} then l.amount else 0 end) as prior_spend
      from ew e
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.id = l.account_id
      join parties p on p.id = l.party_id
      where l.org_id = ${orgId} and a.org_id = ${orgId} and p.org_id = ${orgId}
        and a.type in ('cogs','expense','expense_deferred') and l.party_id is not null
      group by p.id, p.display_name
    `) as Promise<any>,
    db.execute(sql`
      select party_id as id, count(*)::int as bills, max(posting_date) as last_bill
      from documents
      where org_id = ${orgId} and kind = 'vendor_bill' and party_id is not null and status = 'posted' and posting_date <= ${ref}
      group by party_id
    `) as Promise<any>,
    db.execute(sql`
      with ew as materialized (
        select id, posting_date from journal_entries
         where org_id = ${orgId} and posting_date >= ${startIso} and posting_date <= ${to}
      )
      select to_char(e.posting_date, 'YYYY-MM') as month, sum(l.amount) as spend
      from ew e
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.id = l.account_id
      where l.org_id = ${orgId} and a.org_id = ${orgId}
        and a.type in ('cogs','expense','expense_deferred')
      group by 1
    `) as Promise<any>,
    // Payment behaviour: each AP open-item line paid via an application; compare
    // the payment entry's date to the bill's due date.
    db.execute(sql`
      select bl.party_id as id,
        count(*)::int as paid_lines,
        round(avg(pe.posting_date - coalesce(bl.due_date, be.posting_date))::numeric, 1) as avg_days,
        count(*) filter (where pe.posting_date <= coalesce(bl.due_date, be.posting_date))::int as on_time,
        coalesce(sum(a.amount) filter (where pe.posting_date > coalesce(bl.due_date, be.posting_date)), 0) as late_amount
      from applications a
      join journal_lines bl on bl.id = a.to_line_id
      join journal_entries be on be.id = bl.entry_id
      join journal_lines pl on pl.id = a.from_line_id
      join journal_entries pe on pe.id = pl.entry_id
      join accounts ba on ba.id = bl.account_id
      where a.org_id = ${orgId} and bl.org_id = ${orgId} and be.org_id = ${orgId}
        and pl.org_id = ${orgId} and pe.org_id = ${orgId} and ba.org_id = ${orgId}
        and ba.type = 'liability_payable' and a.unapplied_at is null and bl.party_id is not null
        and be.posting_date >= ${from} and be.posting_date <= ${to}
      group by bl.party_id
    `) as Promise<any>,
  ]);

  const billMap = new Map<string, any>((billRows.rows as any[]).map((r) => [r.id, r]));
  const payMap = new Map<string, any>((payRows.rows as any[]).map((r) => [r.id, r]));

  const base = (spendRows.rows as any[])
    .map((r) => {
      const spend = Number(r.spend);
      const priorSpend = Number(r.prior_spend);
      const bm = billMap.get(r.id);
      const pm = payMap.get(r.id);
      const bills = bm ? Number(bm.bills) : 0;
      const lastBill = bm?.last_bill ?? null;
      const paidBills = pm ? Number(pm.paid_lines) : 0;
      const onTime = pm ? Number(pm.on_time) : 0;
      return {
        id: r.id as string,
        name: r.name as string,
        spend,
        priorSpend,
        yoyPct: priorSpend > 0 ? (spend - priorSpend) / priorSpend : null,
        bills,
        avgBill: bills > 0 ? spend / bills : 0,
        lastBill,
        recencyDays: lastBill ? daysBetween(lastBill, ref) : null,
        paidBills,
        avgDaysToPay: pm && pm.avg_days !== null ? Number(pm.avg_days) : null,
        onTimePct: paidBills > 0 ? onTime / paidBills : null,
        latePct: paidBills > 0 ? 1 - onTime / paidBills : null,
        lateSpend: pm ? Number(pm.late_amount) : 0,
      };
    })
    .filter((r) => r.spend > 0.005 || r.priorSpend > 0.005)
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = base.reduce((a, r) => a + r.spend, 0) || 1;
  const sortedSpends = base.map((r) => r.spend).sort((a, b) => a - b);
  // High-spend threshold = 80th percentile ().
  const highSpendThreshold = sortedSpends.length ? sortedSpends[Math.floor(sortedSpends.length * 0.8)] : 0;
  const n = base.length;
  const TIER_SIGNIFICANCE: Record<SpendTier, number> = { strategic: 40, core: 30, tactical: 20, tail: 10 };

  const rows: VendorRow[] = base.map((r, i) => {
    const sharePct = r.spend / totalSpend;
    const tier: SpendTier = i < n * 0.1 ? "strategic" : i < n * 0.3 ? "core" : i < n * 0.6 ? "tactical" : "tail";

    // Relationship-value scorecard (0–100): how strategic/healthy the vendor
    // relationship is. Payment reliability is deliberately NOT in the grade
    // (it measures OUR behaviour, not the vendor's) — it lives on its own tab
    // and feeds the leverage-matrix risk axis instead.
    //  · significance by spend tier (0–40)  · engagement/regularity (0–30)  · spend stability (0–30)
    const significance = TIER_SIGNIFICANCE[tier];
    const engagement = 30 * clamp(Math.min(r.bills, 12) / 12, 0, 1);
    const stability = r.yoyPct === null ? 15 : 30 * clamp(1 - Math.min(Math.abs(r.yoyPct), 1), 0, 1);
    const score = clamp(significance + engagement + stability);

    // Leverage matrix: spend (financial impact) × performance, where our only
    // vendor-performance signal is payment-relationship health (on-time %). No
    // payment history → neutral 50.
    const performance = r.onTimePct === null ? 50 : r.onTimePct * 100;
    const highSpend = r.spend >= highSpendThreshold;
    const highPerf = performance >= 75;
    const quadrant: Quadrant = highSpend
      ? highPerf ? "strategic" : "commodity"
      : highPerf ? "niche" : "transactional";

    return { ...r, sharePct, tier, score, grade: gradeOf(score), performance, quadrant };
  });

  const byMonth = new Map<string, number>((monthRows.rows as any[]).map((r) => [r.month, Number(r.spend)]));
  const monthly: MonthSpend[] = [];
  for (let i = 0; i < 12; i++) {
    const dt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly.push({ month: ym, label: monthLabel(ym), spend: byMonth.get(ym) ?? 0 });
  }

  const spend = rows.reduce((a, r) => a + r.spend, 0);
  const priorSpend = rows.reduce((a, r) => a + r.priorSpend, 0);
  const bills = rows.reduce((a, r) => a + r.bills, 0);
  const hhi = rows.reduce((a, r) => a + r.sharePct ** 2, 0);
  const top5 = rows.slice(0, 5).reduce((a, r) => a + r.spend, 0);
  const top10 = rows.slice(0, 10).reduce((a, r) => a + r.spend, 0);
  const paidTotal = rows.reduce((a, r) => a + r.paidBills, 0);
  const onTimeTotal = rows.reduce((a, r) => a + (r.paidBills * (r.onTimePct ?? 0)), 0);
  const daysWeighted = rows.reduce((a, r) => a + (r.avgDaysToPay !== null ? r.avgDaysToPay * r.paidBills : 0), 0);
  const lateSpend = rows.reduce((a, r) => a + r.lateSpend, 0);

  const tiers: SpendTier[] = ["strategic", "core", "tactical", "tail"];
  const grades: Grade[] = ["A", "B", "C", "D", "F"];
  const quadrants: Quadrant[] = ["strategic", "commodity", "niche", "transactional"];

  return {
    period,
    rows,
    monthly,
    totals: {
      vendors: rows.length,
      spend,
      priorSpend,
      yoyPct: priorSpend > 0 ? (spend - priorSpend) / priorSpend : null,
      bills,
      avgBill: bills > 0 ? spend / bills : 0,
      top5SharePct: spend > 0 ? top5 / spend : 0,
      top10SharePct: spend > 0 ? top10 / spend : 0,
      hhi,
      hhiScaled: Math.round(hhi * 10000),
      strategic: rows.filter((r) => r.tier === "strategic").length,
      onTimePct: paidTotal > 0 ? onTimeTotal / paidTotal : null,
      avgDaysToPay: paidTotal > 0 ? daysWeighted / paidTotal : null,
      lateSpend,
    },
    tierBreakdown: tiers.map((tier) => {
      const set = rows.filter((r) => r.tier === tier);
      return { tier, count: set.length, spend: set.reduce((a, r) => a + r.spend, 0) };
    }),
    gradeBreakdown: grades.map((grade) => {
      const set = rows.filter((r) => r.grade === grade);
      return { grade, count: set.length, spend: set.reduce((a, r) => a + r.spend, 0) };
    }),
    quadrantBreakdown: quadrants.map((quadrant) => {
      const set = rows.filter((r) => r.quadrant === quadrant);
      return { quadrant, count: set.length, spend: set.reduce((a, r) => a + r.spend, 0) };
    }),
  };
}
