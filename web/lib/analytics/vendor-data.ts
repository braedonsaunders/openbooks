import "server-only";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { statementBookExpr } from "../gl-summary";
import { flowRates } from "../fx-presentation";
import { add, mulDecimal } from "@openbooks/engine/src/money/money.ts";
import { addMonthsIso } from "@openbooks/reports";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { englishVendorStrings, type VendorStrings } from "./vendor-strings";

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

interface VendorSpendRow extends Record<string, unknown> {
  id: string; name: string; spend: string | number; prior_spend: string | number;
  func: string | null; late: string | null; late_prior: string | null;
}
interface VendorBillRow extends Record<string, unknown> {
  id: string; bills: string | number; last_bill: string | null;
}
interface MonthSpendRow extends Record<string, unknown> {
  month: string; spend: string | number; func: string | null; late: string | null;
}
interface VendorPaymentRow extends Record<string, unknown> {
  id: string; func: string | null; paid_lines: string | number;
  on_time: string | number; days_sum: string | number | null;
  late_amount: string | number; late_dt: string | null;
}

function priorYear(iso: string): string {
  return addMonthsIso(iso, -12);
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000);
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
  allowed: ReadonlySet<string> | null,
  strings: VendorStrings = englishVendorStrings,
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
    db.execute<VendorSpendRow>(sql`
      with ew as materialized (
        select id, org_id, posting_date from journal_entries
         where org_id = ${orgId} and posting_date >= ${pFrom} and posting_date <= ${to}
           and status in ('posted', 'reversed') and book_id = ${statementBookExpr(orgId)}
      )
      select p.id, coalesce(p.display_name, 'Unknown') as name,
        sub.base_currency as func,
        sum(case when e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as spend,
        sum(case when e.posting_date >= ${pFrom} and e.posting_date <= ${pTo} then l.amount else 0 end) as prior_spend,
        max(e.posting_date) filter (where e.posting_date >= ${from} and e.posting_date <= ${to})::text as late,
        max(e.posting_date) filter (where e.posting_date >= ${pFrom} and e.posting_date <= ${pTo})::text as late_prior
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} and a.org_id = ${orgId} and p.org_id = ${orgId}
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
        and a.type in ('cogs','expense','expense_deferred') and l.party_id is not null
      group by p.id, p.display_name, sub.base_currency
    `),
    db.execute<VendorBillRow>(sql`
      select party_id as id, count(*)::int as bills, max(posting_date) as last_bill
      from documents
      where org_id = ${orgId} and kind = 'vendor_bill' and party_id is not null and status = 'posted'
        and posting_date >= ${from} and posting_date <= ${ref}
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}
      group by party_id
    `),
    db.execute<MonthSpendRow>(sql`
      with ew as materialized (
        select id, org_id, posting_date from journal_entries
         where org_id = ${orgId} and posting_date >= ${startIso} and posting_date <= ${to}
           and status in ('posted', 'reversed') and book_id = ${statementBookExpr(orgId)}
      )
      select to_char(e.posting_date, 'YYYY-MM') as month, sub.base_currency as func,
        sum(l.amount) as spend, max(e.posting_date)::text as late
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} and a.org_id = ${orgId}
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
        and a.type in ('cogs','expense','expense_deferred')
      group by 1, 2
    `),
    // Payment behaviour: collapse applications to one row per AP open-item
    // line before rolling up by vendor. A bill paid in installments must still
    // contribute one paid bill, one on-time decision, and one days-to-pay
    // observation only after full settlement. Days run from the bill date;
    // due dates determine timeliness. Late spend also includes partial payments
    // actually made after due, within the report cutoff.
    db.execute<VendorPaymentRow>(sql`
      with bill_applications as (
        select bl.id as bill_line_id, bl.party_id, be.posting_date as bill_date,
          abs(bl.txn_amount) as bill_total, a.target_transaction_amount as applied_amount,
          coalesce(bl.due_date, be.posting_date) as due_date,
          pe.posting_date as payment_date,
          sub.base_currency as func,
          a.amount
        from applications a
        join journal_lines bl on bl.id = a.to_line_id and bl.org_id = a.org_id
        join journal_entries be on be.id = bl.entry_id and be.org_id = bl.org_id
        join journal_lines pl on pl.id = a.from_line_id and pl.org_id = a.org_id
        join journal_entries pe on pe.id = pl.entry_id and pe.org_id = pl.org_id
        join accounts ba on ba.id = bl.account_id and ba.org_id = bl.org_id
        left join subsidiaries sub on sub.id = bl.subsidiary_id and sub.org_id = bl.org_id
        where a.org_id = ${orgId} and bl.org_id = ${orgId} and be.org_id = ${orgId}
          and pl.org_id = ${orgId} and pe.org_id = ${orgId} and ba.org_id = ${orgId}
          ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, allowed)}
          ${subsidiaryVisibleFilter(sql`pl.subsidiary_id`, allowed)}
          and ba.type = 'liability_payable' and a.unapplied_at is null and bl.party_id is not null
          and be.status in ('posted', 'reversed') and pe.status in ('posted', 'reversed')
          and be.book_id = ${statementBookExpr(orgId)} and pe.book_id = ${statementBookExpr(orgId)}
          and a.applied_on <= ${ref} and pe.posting_date <= ${ref}
          and be.posting_date >= ${from} and be.posting_date <= ${to}
      ), bill_payments as (
        select bill_line_id, party_id, bill_date, due_date, bill_total, func,
          sum(applied_amount) as applied,
          max(payment_date) as last_payment,
          coalesce(sum(amount) filter (where payment_date > due_date), 0) as late_amount
        from bill_applications
        group by bill_line_id, party_id, bill_date, due_date, bill_total, func
      )
      select party_id as id, func,
        count(*) filter (where applied >= bill_total)::int as paid_lines,
        count(*) filter (where applied >= bill_total and last_payment <= due_date)::int as on_time,
        coalesce(sum(last_payment - bill_date) filter (where applied >= bill_total), 0) as days_sum,
        coalesce(sum(late_amount), 0) as late_amount,
        max(last_payment)::text as late_dt
      from bill_payments
      group by party_id, func
    `),
  ]);

  // Spend, late, and payment legs arrive per (party, functional) in
  // line-entity functionals: translate each at its latest posting date,
  // then merge per party in presentation. Day counts stay exact — days
  // re-average from summed day-diffs, weighted by paid bills below.
  const spendRowsTyped = spendRows.rows;
  const spendCtx = await flowRates(orgId, [
    ...spendRowsTyped.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
    ...spendRowsTyped.filter((r) => r.prior_spend != null).map((r) => ({ func: r.func ?? null, date: String(r.late_prior ?? pTo).slice(0, 10) })),
  ]);
  const spendByParty = new Map<string, { name: string; spend: string; priorSpend: string }>();
  for (const r of spendRowsTyped) {
    const cur = spendByParty.get(String(r.id)) ?? { name: strings.displayVendorName(String(r.name)), spend: "0", priorSpend: "0" };
    cur.spend = add(cur.spend, mulDecimal(String(r.spend ?? 0), spendCtx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10))));
    if (r.prior_spend != null) {
      cur.priorSpend = add(cur.priorSpend, mulDecimal(String(r.prior_spend), spendCtx.rateAt(r.func ?? null, String(r.late_prior ?? pTo).slice(0, 10))));
    }
    spendByParty.set(String(r.id), cur);
  }
  const payCtx = await flowRates(orgId, payRows.rows.map((r) => ({
    func: r.func ?? null, date: String(r.late_dt ?? to).slice(0, 10),
  })));
  const paidByParty = new Map<string, { paidBills: number; onTime: number; daysSum: number; lateSpend: string }>();
  for (const r of payRows.rows) {
    const cur = paidByParty.get(String(r.id)) ?? { paidBills: 0, onTime: 0, daysSum: 0, lateSpend: "0" };
    cur.paidBills += Number(r.paid_lines ?? 0);
    cur.onTime += Number(r.on_time ?? 0);
    cur.daysSum += Number(r.days_sum ?? 0);
    cur.lateSpend = add(cur.lateSpend, mulDecimal(String(r.late_amount ?? 0),
      payCtx.rateAt(r.func ?? null, String(r.late_dt ?? to).slice(0, 10))));
    paidByParty.set(String(r.id), cur);
  }
  const monthCtx = await flowRates(orgId, monthRows.rows.map((r) => ({
    func: r.func ?? null, date: String(r.late ?? `${r.month}-01`).slice(0, 10),
  })));
  const spendByMonth = new Map<string, string>();
  for (const r of monthRows.rows) {
    const key = String(r.month);
    spendByMonth.set(key, add(spendByMonth.get(key) ?? "0",
      mulDecimal(String(r.spend ?? 0), monthCtx.rateAt(r.func ?? null, String(r.late ?? `${r.month}-01`).slice(0, 10)))));
  }

  const billMap = new Map(billRows.rows.map((r) => [r.id, r]));

  const base = [...spendByParty.entries()]
    .map(([id, s]) => {
      const spend = Number(s.spend);
      const priorSpend = Number(s.priorSpend);
      const bm = billMap.get(id);
      const pm = paidByParty.get(id);
      const bills = bm ? Number(bm.bills) : 0;
      const lastBill = bm?.last_bill ?? null;
      const paidBills = pm ? pm.paidBills : 0;
      const onTime = pm ? pm.onTime : 0;
      return {
        id,
        name: s.name,
        spend,
        priorSpend,
        yoyPct: priorSpend > 0 ? (spend - priorSpend) / priorSpend : null,
        bills,
        avgBill: bills > 0 ? spend / bills : 0,
        lastBill,
        recencyDays: lastBill ? daysBetween(lastBill, ref) : null,
        paidBills,
        avgDaysToPay: paidBills > 0 && pm ? Math.round((pm.daysSum / paidBills) * 10) / 10 : null,
        onTimePct: paidBills > 0 ? onTime / paidBills : null,
        latePct: paidBills > 0 ? 1 - onTime / paidBills : null,
        lateSpend: pm ? Number(pm.lateSpend) : 0,
      };
    })
    .filter((r) => r.spend > 0 || r.priorSpend > 0)
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = base.reduce((a, r) => a + r.spend, 0) || 1;
  const sortedSpends = base.map((r) => r.spend).sort((a, b) => a - b);
  // High-spend threshold = 80th percentile ().
  const highSpendThreshold = sortedSpends.length ? sortedSpends[Math.floor(sortedSpends.length * 0.8)]! : 0;
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

  const monthly: MonthSpend[] = [];
  for (let i = 0; i < 12; i++) {
    const dt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly.push({ month: ym, label: strings.monthLabel(ym), spend: Number(spendByMonth.get(ym) ?? 0) });
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
