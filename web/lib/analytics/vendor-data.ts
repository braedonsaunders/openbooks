import "server-only";
import { analyticsQuery } from "./query";
import { analyticsSection } from "./read-context";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { statementBookExpr } from "../gl-summary";
import { flowRates } from "../fx-presentation";
import { add, cmp, div, mulDecimal, neg } from "@openbooks/engine/src/money/money.ts";
import { sql } from "drizzle-orm";
import { addMonthsClamped, businessToday, calendarDaysBetween, utcDateFromParts } from "@openbooks/engine/src/platform/business-date.ts";
import { analyticsConfig, type ConfigValuesOf } from "./config";
import { fiscalBucketJoin, fiscalBucketKey, fiscalBucketLabel, fiscalBucketScope, fiscalMonthlyBoxes } from "./fiscal-buckets";
import { vendorStrings, type VendorStrings } from "./vendor-strings";
import { englishCatalogMessage } from "./catalog-strings";

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
 *
 * Money travels as exact decimal strings in the presentation currency from
 * translation to the last sum; only ratios and counts cross into numbers.
 * Every threshold below the loader reads from the organization's own
 * vendorPerformance analytics config — no rate, band or cutoff is constant.
 */

export type SpendTier = "strategic" | "core" | "tactical" | "tail";
export type Grade = "A" | "B" | "C" | "D" | "F";
// Leverage matrix: spend (financial impact) × performance. We proxy
// "performance" with payment-relationship health (on-time %), the only vendor-
// performance signal this ledger supports. Vendors with no payment history
// are "unrated": they keep their spend position but are never plotted, and
// the UI counts them by name instead of scoring them a neutral 50.
export type Quadrant = "strategic" | "commodity" | "niche" | "transactional" | "unrated";

export type VendorPerformanceConfig = ConfigValuesOf<"vendorPerformance">;

export interface VendorRow {
  id: string;
  name: string;
  spend: string;
  priorSpend: string;
  yoyPct: number | null;
  sharePct: number;
  bills: number;
  avgBill: string;
  lastBill: string | null;
  recencyDays: number | null;
  tier: SpendTier;
  // payment behaviour (how we pay this vendor)
  paidBills: number;
  undatedBills: number; // settled lines with no due date or payment terms
  avgDaysToPay: number | null;
  onTimePct: number | null;
  latePct: number | null;
  lateSpend: string;
  // derived scores
  score: number; // 0–100 relationship scorecard
  grade: Grade;
  performance: number | null; // 0–100 payment-relationship health (matrix Y axis), null when unrated
  quadrant: Quadrant;
  // Why an unrated vendor is unrated: "no-payments" means no settled bills
  // at all, "undated" means settled bills with no due date or payment terms.
  // The remedies differ (settle bills vs date them), so the reason travels
  // with the row; null whenever the vendor is rated.
  unratedReason: "no-payments" | "undated" | null;
}

export interface MonthSpend {
  month: string;
  label: string;
  spend: string;
}

export interface VendorData {
  period: { from: string; to: string; label: string };
  config: VendorPerformanceConfig;
  rows: VendorRow[];
  monthly: MonthSpend[];
  totals: {
    vendors: number;
    spend: string;
    priorSpend: string;
    yoyPct: number | null;
    bills: number;
    avgBill: string;
    top5SharePct: number;
    top10SharePct: number;
    hhi: number;
    hhiScaled: number; // 0–10000 (the classic HHI scale)
    strategic: number;
    onTimePct: number | null;
    avgDaysToPay: number | null;
    lateSpend: string;
    undatedBills: number; // settled bill lines with no due date or payment terms, excluded from on-time figures
  };
  tierBreakdown: { tier: SpendTier; count: number; spend: string }[];
  gradeBreakdown: { grade: Grade; count: number; spend: string }[];
  quadrantBreakdown: { quadrant: Quadrant; count: number; spend: string }[];
}

interface VendorSpendRow extends Record<string, unknown> {
  id: string; name: string; spend: string | number; prior_spend: string | number;
  func: string | null; late: string | null; late_prior: string | null;
}
interface VendorBillRow extends Record<string, unknown> {
  id: string; bills: string | number; last_bill: string | null;
}
interface MonthSpendRow extends Record<string, unknown> {
  bucket: string; bucket_label: string | null; spend: string | number; func: string | null; late: string | null;
}
interface VendorPaymentRow extends Record<string, unknown> {
  id: string; func: string | null; paid_lines: string | number;
  on_time: string | number; days_sum: string | number | null;
  late_amount: string | number; late_dt: string | null; undated: string | number;
}

function priorYear(iso: string): string {
  return addMonthsClamped(iso, -12);
}
function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}
function gradeOf(score: number, c: VendorPerformanceConfig): Grade {
  if (score >= c.gradeA) return "A";
  if (score >= c.gradeB) return "B";
  if (score >= c.gradeC) return "C";
  if (score >= c.gradeD) return "D";
  return "F";
}

export async function vendorData(
  period: { from: string; to: string; label: string },
  orgId: string,
  allowed: ReadonlySet<string> | null,
  strings: VendorStrings = vendorStrings(englishCatalogMessage, "en"),
): Promise<VendorData> {
  const { from, to } = period;
  const pFrom = priorYear(from);
  const pTo = priorYear(to);
  const includeMonthly = analyticsSection('vendor-performance', ['overview'], { summary: true });
  const [today, config, buckets] = await Promise.all([
    businessToday(orgId),
    analyticsConfig(orgId, "vendorPerformance"),
    fiscalBucketScope(orgId),
  ]);
  const ref = to < today ? to : today;
  const end = new Date(to + "T00:00:00Z");
  // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999.
  const start = utcDateFromParts(end.getUTCFullYear(), end.getUTCMonth() - 11, 1);
  // The trend window opens twelve calendar months back — but a fiscal
  // series names whole declared periods, so a straddling first period
  // would read as one partial box under a full-period name. Open at the
  // first overlapping period's start instead (extending only, so gap days
  // ahead of declared coverage still render as fallback boxes).
  let startIso = start.toISOString().slice(0, 10);
  if (buckets.useFiscal) {
    const first = buckets.periods
      .filter((p) => p.to >= startIso && p.from <= to)
      .map((p) => p.from)
      .sort()[0];
    if (first && first < startIso) startIso = first;
  }

  const [spendRows, billRows, monthRows, payRows] = await Promise.all([
    // Entry window first: joined inline the planner drives from accounts and
    // probes the entry primary key once per journal line in the tenant.
    // Resolve live vendor membership and labels after the scoped ledger
    // aggregation, so those lookups run per vendor/functional instead of line.
    // The vendor universe is parties holding a vendor role — expense lines
    // posted against employees or customers are not vendor spend.
    analyticsQuery<VendorSpendRow>(sql`
      with ew as materialized (
        select id, org_id, posting_date from journal_entries
         where org_id = ${orgId} and posting_date >= ${pFrom} and posting_date <= ${to}
           and status in ('posted', 'reversed') and book_id = ${statementBookExpr(orgId)}
      ), spend as materialized (
        select l.party_id as id, sub.base_currency as func,
          sum(case when e.posting_date >= ${from} and e.posting_date <= ${to} then l.amount else 0 end) as spend,
          sum(case when e.posting_date >= ${pFrom} and e.posting_date <= ${pTo} then l.amount else 0 end) as prior_spend,
          max(e.posting_date) filter (where e.posting_date >= ${from} and e.posting_date <= ${to})::text as late,
          max(e.posting_date) filter (where e.posting_date >= ${pFrom} and e.posting_date <= ${pTo})::text as late_prior
        from ew e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
        left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
        where l.org_id = ${orgId} and a.org_id = ${orgId}
          ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
          and a.type in ('cogs','expense','expense_deferred') and l.party_id is not null
        group by l.party_id, sub.base_currency
      )
      select p.id, coalesce(p.display_name, 'Unknown') as name,
        spend.func, spend.spend, spend.prior_spend, spend.late, spend.late_prior
      from spend
      join parties p on p.id = spend.id and p.org_id = ${orgId}
      join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
    `),
    (analyticsSection('vendor-performance', ["overview","payment","scorecard","matrix","vendors"]) ? analyticsQuery<VendorBillRow>(sql`
      with bill_movements as (
        select d.party_id, d.posting_date::date as movement_date, 1::int as direction
          from documents d
          join vendor_roles vr on vr.party_id = d.party_id and vr.org_id = d.org_id
         where d.org_id = ${orgId} and d.kind = 'vendor_bill' and d.party_id is not null
           and d.status in ('posted', 'voided') and d.posting_date::date between ${from}::date and ${ref}::date
           ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
        union all
        select d.party_id, coalesce(reversal_entry.posting_date::date, d.voided_at::date) as movement_date, -1::int as direction
          from documents d
          join vendor_roles vr on vr.party_id = d.party_id and vr.org_id = d.org_id
          left join journal_entries reversal_entry on reversal_entry.id = d.reversal_entry_id and reversal_entry.org_id = d.org_id
         where d.org_id = ${orgId} and d.kind = 'vendor_bill' and d.party_id is not null
           and d.status = 'voided' and d.voided_at is not null
           and coalesce(reversal_entry.posting_date::date, d.voided_at::date) between ${from}::date and ${ref}::date
           ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
      )
      select party_id as id, sum(direction)::int as bills, max(movement_date) as last_bill
        from bill_movements
       group by party_id
      having sum(direction) <> 0
    `) : Promise.resolve({rows:[]})),
    (includeMonthly ? analyticsQuery<MonthSpendRow>(sql`
      with ew as materialized (
        select id, org_id, posting_date from journal_entries
         where org_id = ${orgId} and posting_date >= ${startIso} and posting_date <= ${to}
           and status in ('posted', 'reversed') and book_id = ${statementBookExpr(orgId)}
      )
      select ${fiscalBucketKey(sql`e.posting_date`, buckets.useFiscal)} as bucket,
        ${fiscalBucketLabel(sql`e.posting_date`, buckets.useFiscal)} as bucket_label,
        sub.base_currency as func,
        sum(l.amount) as spend, max(e.posting_date)::text as late
      from ew e
      join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join parties p on p.id = l.party_id and p.org_id = l.org_id
      join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      ${fiscalBucketJoin(orgId, sql`e.posting_date`, buckets.useFiscal)}
      where l.org_id = ${orgId} and a.org_id = ${orgId} and p.org_id = ${orgId}
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
        and a.type in ('cogs','expense','expense_deferred') and l.party_id is not null
      group by 1, 2, sub.base_currency
    `) : Promise.resolve({ rows: [] })),
    // Payment behaviour: collapse applications to one row per AP open-item
    // line before rolling up by vendor. A bill paid in installments must still
    // contribute one paid bill, one on-time decision, and one days-to-pay
    // observation only after full settlement. Timeliness runs from the open
    // item's own due date first (journal AP lines and migrated or opening
    // balances carry one with no linked vendor bill), else the bill's due
    // date, else the vendor's payment terms counted from the bill date;
    // settled lines with none of the three are excluded from the on-time rate
    // and late spend and counted as undated. Days-to-pay needs no due date
    // and keeps every settled line. Late spend also includes partial payments
    // actually made after due, within the report cutoff.
    analyticsQuery<VendorPaymentRow>(sql`
      with bill_applications as (
        select bl.id as bill_line_id, bl.party_id, be.posting_date as bill_date,
          abs(bl.txn_amount) as bill_total, a.target_transaction_amount as applied_amount,
          coalesce(bl.due_date, bill.due_date, case when pt.net_days is not null then (be.posting_date + pt.net_days)::date end) as due_date,
          pe.posting_date as payment_date,
          sub.base_currency as func,
          a.amount
        from applications a
        join journal_lines bl on bl.id = a.to_line_id and bl.org_id = a.org_id
        join journal_entries be on be.id = bl.entry_id and be.org_id = bl.org_id
        left join documents bill on bill.id = be.source_document_id and bill.org_id = be.org_id
          and bill.kind = 'vendor_bill'
        join vendor_roles vr on vr.party_id = bl.party_id and vr.org_id = bl.org_id
        left join payment_terms pt on pt.id = vr.payment_terms_id and pt.org_id = vr.org_id
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
          coalesce(sum(amount) filter (where due_date is not null and payment_date > due_date), 0) as late_amount
        from bill_applications
        group by bill_line_id, party_id, bill_date, due_date, bill_total, func
      )
      select party_id as id, func,
        count(*) filter (where applied >= bill_total)::int as paid_lines,
        count(*) filter (where applied >= bill_total and due_date is not null and last_payment <= due_date)::int as on_time,
        coalesce(sum(last_payment - bill_date) filter (where applied >= bill_total), 0) as days_sum,
        coalesce(sum(late_amount), 0) as late_amount,
        max(last_payment)::text as late_dt,
        count(*) filter (where applied >= bill_total and due_date is null)::int as undated
      from bill_payments
      group by party_id, func
    `),
  ]);

  // Spend, late, and payment legs arrive per (party, functional) in
  // line-entity functionals: translate each at its latest posting date,
  // then merge per party in presentation. Day counts stay exact — days
  // re-average from summed day-diffs, weighted by paid bills below.
  const spendRowsTyped = spendRows.rows;
  const flowCtx = await flowRates(orgId, [
    ...spendRowsTyped.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
    ...spendRowsTyped.filter((r) => r.prior_spend != null).map((r) => ({ func: r.func ?? null, date: String(r.late_prior ?? pTo).slice(0, 10) })),
    ...payRows.rows.map((r) => ({ func: r.func ?? null, date: String(r.late_dt ?? to).slice(0, 10) })),
    ...monthRows.rows.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
  ]);
  const spendByParty = new Map<string, { name: string; spend: string; priorSpend: string }>();
  for (const r of spendRowsTyped) {
    const cur = spendByParty.get(String(r.id)) ?? { name: strings.displayVendorName(String(r.name)), spend: "0", priorSpend: "0" };
    cur.spend = add(cur.spend, mulDecimal(String(r.spend ?? 0), flowCtx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10))));
    if (r.prior_spend != null) {
      cur.priorSpend = add(cur.priorSpend, mulDecimal(String(r.prior_spend), flowCtx.rateAt(r.func ?? null, String(r.late_prior ?? pTo).slice(0, 10))));
    }
    spendByParty.set(String(r.id), cur);
  }
  const paidByParty = new Map<string, { paidBills: number; onTime: number; daysSum: number; lateSpend: string; undated: number }>();
  for (const r of payRows.rows) {
    const cur = paidByParty.get(String(r.id)) ?? { paidBills: 0, onTime: 0, daysSum: 0, lateSpend: "0", undated: 0 };
    cur.paidBills += Number(r.paid_lines ?? 0);
    cur.onTime += Number(r.on_time ?? 0);
    cur.daysSum += Number(r.days_sum ?? 0);
    cur.lateSpend = add(cur.lateSpend, mulDecimal(String(r.late_amount ?? 0),
      flowCtx.rateAt(r.func ?? null, String(r.late_dt ?? to).slice(0, 10))));
    cur.undated += Number(r.undated ?? 0);
    paidByParty.set(String(r.id), cur);
  }
  const spendByBucket = new Map<string, string>();
  for (const r of monthRows.rows) {
    const key = String(r.bucket);
    spendByBucket.set(key, add(spendByBucket.get(key) ?? "0",
      mulDecimal(String(r.spend ?? 0), flowCtx.rateAt(r.func ?? null, String(r.late ?? to).slice(0, 10)))));
  }
  const bucketLabels = new Map<string, string>();
  for (const r of monthRows.rows) {
    const key = String(r.bucket);
    if (!bucketLabels.has(key) && r.bucket_label != null) bucketLabels.set(key, String(r.bucket_label));
  }

  const billMap = new Map(billRows.rows.map((r) => [r.id, r]));
  const zero = "0";

  const base = [...spendByParty.entries()]
    .map(([id, s]) => {
      const bm = billMap.get(id);
      const pm = paidByParty.get(id);
      const bills = bm ? Number(bm.bills) : 0;
      const lastBill = bm?.last_bill ?? null;
      const paidBills = pm ? pm.paidBills : 0;
      const onTime = pm ? pm.onTime : 0;
      // Settled lines with no due date or payment terms are excluded from
      // the on-time figure entirely — neither the numerator nor the
      // denominator — and counted as undated instead.
      const undatedBills = pm ? pm.undated : 0;
      const datedBills = paidBills - undatedBills;
      const priorPositive = cmp(s.priorSpend, zero) > 0;
      return {
        id,
        name: s.name,
        spend: s.spend,
        priorSpend: s.priorSpend,
        yoyPct: priorPositive ? Number(div(add(s.spend, neg(s.priorSpend)), s.priorSpend)) : null,
        bills,
        avgBill: bills > 0 ? div(s.spend, String(bills)) : zero,
        lastBill,
        recencyDays: lastBill ? calendarDaysBetween(lastBill, ref) : null,
        paidBills,
        undatedBills,
        avgDaysToPay: paidBills > 0 && pm ? Math.round((pm.daysSum / paidBills) * 10) / 10 : null,
        onTimePct: datedBills > 0 ? onTime / datedBills : null,
        latePct: datedBills > 0 ? 1 - onTime / datedBills : null,
        lateSpend: pm ? pm.lateSpend : zero,
      };
    })
    .filter((r) => cmp(r.spend, zero) > 0 || cmp(r.priorSpend, zero) > 0)
    .sort((a, b) => cmp(b.spend, a.spend));

  // Shares must add up over the vendors actually shown: vendors filtered
  // out of the rows above (net spend at or below zero) contribute nothing
  // here, or HHI and top-N shares would sum past one against a total that
  // still carries vendors nobody sees.
  const totalSpend = base.reduce((a, r) => add(a, r.spend), zero);
  const spendPositive = cmp(totalSpend, zero) > 0;
  const sortedSpends = base.map((r) => r.spend).sort(cmp);
  // High-spend threshold at the configured percentile of the vendor spend
  // distribution (80th by default).
  const highSpendThreshold = sortedSpends.length
    ? sortedSpends[Math.min(sortedSpends.length - 1, Math.floor(sortedSpends.length * config.highSpendPercentile / 100))]!
    : zero;
  const n = base.length;
  const significance: Record<SpendTier, number> = {
    strategic: config.significanceStrategic,
    core: config.significanceCore,
    tactical: config.significanceTactical,
    tail: config.significanceTail,
  };

  const rows: VendorRow[] = base.map((r, i) => {
    const sharePct = spendPositive ? Number(div(r.spend, totalSpend)) : 0;
    const tier: SpendTier = i < n * config.tierStrategicPct / 100 ? "strategic"
      : i < n * config.tierCorePct / 100 ? "core"
      : i < n * config.tierTacticalPct / 100 ? "tactical" : "tail";

    // Relationship-value scorecard (0–100): how strategic/healthy the vendor
    // relationship is. Payment reliability is deliberately NOT in the grade
    // (it measures OUR behaviour, not the vendor's) — it lives on its own tab
    // and feeds the leverage-matrix risk axis instead. Sub-score ceilings
    // come from the organization's own vendorPerformance config.
    const tierSignificance = significance[tier];
    const engagement = config.engagementMaxPoints * clamp(Math.min(r.bills, config.engagementCapBills) / config.engagementCapBills, 0, 1);
    const stability = r.yoyPct === null ? config.neutralStabilityScore : config.stabilityMaxPoints * clamp(1 - Math.min(Math.abs(r.yoyPct), 1), 0, 1);
    const score = clamp(tierSignificance + engagement + stability);

    // Leverage matrix: spend (financial impact) × performance, where our only
    // vendor-performance signal is payment-relationship health (on-time %).
    // Vendors with no measurable timeliness are unrated — never a neutral 50.
    const performance = r.onTimePct === null ? null : r.onTimePct * 100;
    const highSpend = cmp(r.spend, highSpendThreshold) >= 0;
    const highPerf = (performance ?? -1) >= config.highPerformanceScore;
    const quadrant: Quadrant = performance === null ? "unrated"
      : highSpend ? highPerf ? "strategic" : "commodity"
      : highPerf ? "niche" : "transactional";
    const unratedReason = performance === null ? (r.paidBills === 0 ? "no-payments" : "undated") : null;

    return { ...r, sharePct, tier, score, grade: gradeOf(score, config), performance, quadrant, unratedReason };
  });

  const monthly: MonthSpend[] = !includeMonthly ? [] : buckets.useFiscal
    ? fiscalMonthlyBoxes(buckets.periods, startIso, to, spendByBucket, zero, bucketLabels, (ym) => strings.monthLabel(ym))
    : Array.from({ length: 12 }, (_, i) => {
        const dt = utcDateFromParts(start.getUTCFullYear(), start.getUTCMonth() + i, 1);
        const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
        return { month: ym, label: strings.monthLabel(ym), spend: spendByBucket.get(ym) ?? zero };
      });

  const spend = rows.reduce((a, r) => add(a, r.spend), zero);
  const priorSpend = rows.reduce((a, r) => add(a, r.priorSpend), zero);
  const bills = rows.reduce((a, r) => a + r.bills, 0);
  const spendIsPositive = cmp(spend, zero) > 0;
  const priorIsPositive = cmp(priorSpend, zero) > 0;
  const hhi = rows.reduce((a, r) => a + r.sharePct ** 2, 0);
  const top5 = rows.slice(0, 5).reduce((a, r) => add(a, r.spend), zero);
  const top10 = rows.slice(0, 10).reduce((a, r) => add(a, r.spend), zero);
  const paidTotal = rows.reduce((a, r) => a + r.paidBills, 0);
  const datedTotal = rows.reduce((a, r) => a + (r.paidBills - r.undatedBills), 0);
  const onTimeTotal = rows.reduce((a, r) => a + ((r.paidBills - r.undatedBills) * (r.onTimePct ?? 0)), 0);
  const daysWeighted = rows.reduce((a, r) => a + (r.avgDaysToPay !== null ? r.avgDaysToPay * r.paidBills : 0), 0);
  const lateSpend = rows.reduce((a, r) => add(a, r.lateSpend), zero);
  // Undated bills count only vendors actually shown: summing the payment
  // map would include vendors filtered out of the rows above.
  const undatedBills = rows.reduce((a, r) => a + r.undatedBills, 0);

  const tiers: SpendTier[] = ["strategic", "core", "tactical", "tail"];
  const grades: Grade[] = ["A", "B", "C", "D", "F"];
  const quadrants: Quadrant[] = ["strategic", "commodity", "niche", "transactional", "unrated"];

  const sumSpend = (set: VendorRow[]): string => set.reduce((a, r) => add(a, r.spend), zero);

  return {
    period,
    config,
    rows,
    monthly,
    totals: {
      vendors: rows.length,
      spend,
      priorSpend,
      yoyPct: priorIsPositive ? Number(div(add(spend, neg(priorSpend)), priorSpend)) : null,
      bills,
      avgBill: bills > 0 ? div(spend, String(bills)) : zero,
      top5SharePct: spendIsPositive ? Number(div(top5, spend)) : 0,
      top10SharePct: spendIsPositive ? Number(div(top10, spend)) : 0,
      hhi,
      hhiScaled: Math.round(hhi * 10000),
      strategic: rows.filter((r) => r.tier === "strategic").length,
      onTimePct: datedTotal > 0 ? onTimeTotal / datedTotal : null,
      avgDaysToPay: paidTotal > 0 ? daysWeighted / paidTotal : null,
      lateSpend,
      undatedBills,
    },
    tierBreakdown: tiers.map((tier) => {
      const set = rows.filter((r) => r.tier === tier);
      return { tier, count: set.length, spend: sumSpend(set) };
    }),
    gradeBreakdown: grades.map((grade) => {
      const set = rows.filter((r) => r.grade === grade);
      return { grade, count: set.length, spend: sumSpend(set) };
    }),
    quadrantBreakdown: quadrants.map((quadrant) => {
      const set = rows.filter((r) => r.quadrant === quadrant);
      return { quadrant, count: set.length, spend: sumSpend(set) };
    }),
  };
}
