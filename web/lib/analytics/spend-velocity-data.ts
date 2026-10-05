import "server-only";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { statementBookExpr } from "../gl-summary";
import { flowRates } from "../fx-presentation";
import { add, cmp, div, mulDecimal, neg } from "@openbooks/engine/src/money/money.ts";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { analyticsConfig, ANALYTICS_CONFIG, type ConfigValuesOf } from "./config";
import { fiscalBucketJoin, fiscalBucketKey, fiscalBucketLabel, fiscalBucketScope } from "./fiscal-buckets";
import { operatingExpenseRatio, periodOperatingExpenses } from "./operating-expenses";
import { spendVelocityStrings, type SpendVelocityStrings } from "./spend-velocity-strings";
import { englishCatalogMessage } from "./catalog-strings";
import { getMoneyFormatter } from '../money-server'
import { addMonthsClamped } from '@openbooks/engine/src/platform/business-date.ts';
import { toChartNumber } from "../chart-number";

/**
 * Spend Velocity — an implementation of the SpendVelocity dashboard
 * (Lib_SpendVelocity_Data.js, account-centric v3).
 *
 * Source data mirrors the four spend transaction types exactly:
 * vendor_bill / expense_report / check (positive) net of vendor_credit —
 * as journal lines on expense/COGS accounts, grouped account × period
 * (primary) and vendor × period (drill-down). PO vs SO velocity feeds the
 * Commitment Cliff; customer invoices feed revenue normalisation.
 *
 * Velocity engine: monthly CAGR with a minimum-base guard; acceleration =
 * recent-half CAGR − early-half CAGR; trends classified by the configured
 * high/medium thresholds. Detectors: statistical anomalies, boiling frog
 * (small monotonic creep), zombie subscriptions (identical recurring vendor
 * totals), category fragmentation (many small txns), concentration risk
 * (HHI), seasonal patterns, commitment cliff. Health score = 100 −
 * severity-weighted deductions. Every threshold below reads from the
 * organization's own spendVelocity analytics config — no cutoff, weight,
 * horizon or band is constant.
 *
 * Money travels as exact decimal strings in the presentation currency from
 * translation to the last sum (single exact→Number crossings feed only the
 * CAGR/z-score rate math and the charts). An unset optional money threshold
 * disables the detector that needs it by name instead of inventing a value:
 * with no fragmentation size cap the fragmentation detector reports itself
 * unconfigured; with no minimum base the velocity engine scores every series
 * from its first month and says so on the Configuration tab.
 *
 * HONEST GAP: the Shadow IT detector needs a line-level VENDOR on
 * expense-report lines (who the employee actually paid). openbooks expense
 * lines carry only the expense account + free-text description, so that
 * detector is reported as unavailable rather than faked.
 */

export type SpendVelocityConfig = ConfigValuesOf<"spendVelocity">;

const SPEND_KINDS = ["vendor_bill", "expense_report", "check", "vendor_credit"] as const;

// ---- shapes -----------------------------------------------------------------

export interface VelocityRow {
  id: string;
  name: string;
  entityType: "account" | "vendor";
  totalSpend: string;
  totalBills: string;
  totalExpenses: string;
  totalOther: string;
  billPct: number;
  expensePct: number;
  transactionCount: number;
  monthCount: number;
  velocity: number;
  acceleration: number;
  trend: "accelerating" | "high" | "rising" | "declining" | "stable" | "new";
  latestSpend: string;
  previousSpend: string;
  avgMonthlySpend: string;
  monthlyAmounts: number[];
  monthLabels: string[];
}

export interface SVAnomaly {
  accountId: string;
  accountName: string;
  month: string;
  amount: string;
  expectedAmount: string;
  deviation: number;
  zScore: number;
  type: "spike" | "drop";
  severity: "critical" | "warning";
}

export interface SVInsight {
  type: "alert" | "warning" | "info";
  title: string;
  message: string;
  action: string;
}

export interface SpendVelocityData {
  period: { from: string; to: string; label: string };
  config: SpendVelocityConfig;
  summary: {
    totalSpend: string;
    accountCount: number;
    avgVelocity: number;
    avgAcceleration: number;
    acceleratingCount: number;
    deceleratingCount: number;
    highVelocityCount: number;
    healthScore: number;
    healthGrade: string;
    billsTotal: string;
    expensesTotal: string;
    billsVelocity: number;
    expensesVelocity: number;
    savingsPotential: string;
    totalAlerts: number;
  };
  accountVelocity: VelocityRow[];
  vendorVelocity: VelocityRow[];
  anomalies: { summary: { count: number; spikeCount: number; dropCount: number; criticalCount: number }; items: SVAnomaly[] };
  monthlyTrends: {
    month: string;
    label: string;
    totalAmount: string;
    transactionCount: number;
    billAmount: string;
    expenseAmount: string;
    vendorCount: number;
    priorYearAmount: string;
    yoyChange: number | null;
    velocity: number | null;
  }[];
  seasonal: {
    patterns: { month: number; monthName: string; totalSpend: string; deviation: number; isHigh: boolean; isLow: boolean }[];
    insights: { type: string; message: string }[];
  };
  boilingFrog: {
    summary: { count: number; criticalCount: number; totalAnnualizedCreep: string };
    accounts: {
      accountId: string; accountName: string; monotonicRatio: number; avgMonthlyIncrease: number; totalCreep: number;
      startAmount: string; endAmount: string; monthCount: number; annualizedCreep: string; monthlyAmounts: number[];
      severity: "critical" | "warning" | "info";
    }[];
  };
  concentration: {
    summary: { hhi: number; hhiStatus: string; top1Share: number; top5Share: number; top10Share: number; riskAccountCount: number };
    accounts: (VelocityRow & { spendShare: number })[];
  };
  zombies: {
    summary: { count: number; criticalCount: number; totalAnnualCost: string };
    subscriptions: { vendorId: string; vendorName: string; amount: string; monthCount: number; annualCost: string; firstMonth: string; lastMonth: string; severity: "critical" | "warning" }[];
  };
  fragmentation: {
    summary: { fragmentedCategories: number; totalFragmentedSpend: string; configured: boolean; reason: string };
    categories: { accountId: string; accountName: string; totalSpend: string; transactionCount: number; avgTransactionSize: string; txnsPerMonth: number; fragmentationScore: number }[];
  };
  shadowIT: { available: false; reason: string };
  commitmentCliff: {
    summary: { poVelocity: number | null; soVelocity: number | null; velocityGap: number | null; ratio: number; status: "healthy" | "warning" | "critical"; monthsToCliff: number | null; totalPO: string; totalSO: string };
    months: { month: string; poAmount: string; soAmount: string }[];
  };
  revenue: { hasData: boolean; totalRevenue: string; opexRatio: number };
  insights: SVInsight[];
  periodComparison: {
    summary: { currentTotal: string; priorTotal: string; twoBackTotal: string; projectedTotal: string; changePct: number | null; priorLabel: string; twoBackLabel: string };
    accounts: { accountId: string; accountName: string; currentAmount: string; priorAmount: string; twoBackAmount: string; changePct: number | null; projectedAmount: string; isNew: boolean; monthlyTrend: number[]; velocity: number; acceleration: number; trend: string }[];
  };
  expenseAnalysis: {
    summary: { expenseReportTotal: string; vendorBillTotal: string; topSpenderCount: number; categoryIncreaseTotal: string };
    topSpenders: { employeeId: string; employeeName: string; totalSpend: string; priorSpend: string; reportCount: number; changePct: number | null }[];
    categories: { categoryId: string; categoryName: string; currentAmount: string; priorAmount: string; changePct: number | null }[];
    monthlyTrends: { month: string; expenseAmount: string; billAmount: string }[];
  };
}

// ---- CAGR velocity engine (stable) ---------------------------------

function calculateCAGR(startValue: number, endValue: number, periods: number): number {
  if (periods < 1 || startValue <= 0) return 0;
  if (endValue <= 0) return -100;
  const cagr = (Math.pow(endValue / startValue, 1 / periods) - 1) * 100;
  return Math.max(-100, Math.min(200, cagr));
}

type VelocityEngine = Pick<SpendVelocityConfig, "velocityHighThreshold" | "velocityMediumThreshold" | "minBaseAmount">;
const specDefaults = ANALYTICS_CONFIG.spendVelocity.defaults;
const DEFAULT_VELOCITY_ENGINE: VelocityEngine = {
  velocityHighThreshold: specDefaults.velocityHighThreshold,
  velocityMediumThreshold: specDefaults.velocityMediumThreshold,
  minBaseAmount: specDefaults.minBaseAmount,
};

/** Growth from a zero base is undefined: leading non-positive buckets are never
 * a start point, so a zero first month no longer fabricates a flat 0 velocity.
 * An empty minimum base means no floor beyond that: every positive series
 * scores from its first month. */
function velocityCAGR(monthlyAmounts: number[], minBase: string): number {
  if (!monthlyAmounts || monthlyAmounts.length < 2) return 0;
  let first = 0;
  while (first < monthlyAmounts.length && monthlyAmounts[first]! <= 0) first++;
  const scored = monthlyAmounts.slice(first);
  if (scored.length < 2) return 0;
  let start = scored[0]!;
  let periods = scored.length - 1;
  const end = scored[scored.length - 1]!;
  if (minBase !== "") {
    const floor = Number(minBase);
    if (start < floor) {
      let found = false;
      for (let i = 0; i < scored.length - 1; i++) {
        if (scored[i]! >= floor) { start = scored[i]!; periods = scored.length - 1 - i; found = true; break; }
      }
      if (!found) return 0;
    }
  }
  return calculateCAGR(start, end, periods);
}

export function velocityAndAcceleration(amounts: number[], C: VelocityEngine = DEFAULT_VELOCITY_ENGINE): { velocity: number; acceleration: number; trend: VelocityRow["trend"] } {
  let velocity = 0, acceleration = 0;
  let trend: VelocityRow["trend"] = "stable";
  if (amounts.length >= 2) {
    velocity = velocityCAGR(amounts, C.minBaseAmount);
    if (amounts.length >= 4) {
      const mid = Math.floor(amounts.length / 2);
      acceleration = velocityCAGR(amounts.slice(mid), C.minBaseAmount) - velocityCAGR(amounts.slice(0, mid), C.minBaseAmount);
    }
    if (velocity > C.velocityHighThreshold) trend = acceleration > 0 ? "accelerating" : "high";
    else if (velocity > C.velocityMediumThreshold) trend = "rising";
    else if (velocity < -C.velocityMediumThreshold) trend = "declining";
  } else if (amounts.length === 1) {
    trend = "new";
  }
  return { velocity: Math.round(velocity * 10) / 10, acceleration: Math.round(acceleration * 10) / 10, trend };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Exact-string twin of {@link velocityCAGR} for commitment series: leading
 * non-positive buckets are never a start point (a zero first month no longer
 * divides by zero), the configured floor applies on top of the skipped
 * series, and fewer than two measurable buckets — or no bucket above the
 * floor — yields null so the detector renders its named reason instead of a
 * fabricated 0. A measured collapse to zero still reads −100. */
/**
 * Periods until purchase commitments outrun sales coverage at the measured
 * pace. PO growing `gap` points faster per period compounds the PO/SO ratio
 * by (1 + gap/100) each period, so reaching `target` from `ratio` takes
 * ln(target/ratio) / ln(1 + gap/100) periods — a horizon derived from the
 * two figures shown, not a configured guess. Null when there is no positive
 * pace or no sales base to compound against.
 */
export function monthsToCliffFor(gap: number, ratio: number, target: number): number | null {
  if (!(gap > 0) || !(ratio > 0) || !(target > 0)) return null;
  if (ratio >= target) return 1;
  return Math.max(1, Math.round(Math.log(target / ratio) / Math.log(1 + gap / 100)));
}

export function moneyCagr(amounts: string[], minimum: string): number | null {
  let first = 0;
  while (first < amounts.length && cmp(amounts[first]!, "0") <= 0) first++;
  const scored = amounts.slice(first);
  if (scored.length < 2) return null;
  let start = scored[0]!;
  let periods = scored.length - 1;
  const end = scored[scored.length - 1]!;
  if (minimum !== "") {
    if (cmp(start, minimum) < 0) {
      let found = false;
      for (let i = 0; i < scored.length - 1; i++) {
        if (cmp(scored[i]!, minimum) >= 0) { start = scored[i]!; periods = scored.length - 1 - i; found = true; break; }
      }
      if (!found) return null;
    }
  }
  if (cmp(end, "0") <= 0) return -100;
  const ratio = toChartNumber(div(end, start));
  return Math.max(-100, Math.min(200, (Math.pow(ratio, 1 / periods) - 1) * 100));
}

export interface SpendVelocityComparisonWindows {
  periodDays: number;
  priorFrom: string;
  priorTo: string;
  twoBackFrom: string;
  twoBackTo: string;
}

/**
 * Build the back-to-back comparison windows for an inclusive current period.
 * Current queries use `>= from`/`<= to`, while prior queries use
 * `>= priorFrom`/`< from`; shifting by the inclusive day count keeps those
 * windows equal in length.
 */
export function getSpendVelocityComparisonWindows(from: string, to: string): SpendVelocityComparisonWindows {
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const periodDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const priorStart = new Date(start.getTime() - periodDays * 86_400_000);
  const twoBackStart = new Date(priorStart.getTime() - periodDays * 86_400_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  return {
    periodDays,
    priorFrom: ymd(priorStart),
    priorTo: ymd(new Date(start.getTime() - 86_400_000)),
    twoBackFrom: ymd(twoBackStart),
    twoBackTo: ymd(new Date(priorStart.getTime() - 86_400_000)),
  };
}

type SqlNumber = string | number | null;
interface AccountSpendRow extends Record<string, unknown> {
  account_id: string; account_name: string | null; bucket: string; bucket_label: string | null; month_num: number;
  bill_amount: SqlNumber; expense_amount: SqlNumber; check_amount: SqlNumber; credit_amount: SqlNumber;
  total_amount: SqlNumber; transaction_count: SqlNumber; doc_ids: string[] | null; func: string | null; late: string | null;
}
interface VendorSpendRow extends Record<string, unknown> {
  vendor_id: string; vendor_name: string; bucket: string; bucket_label: string | null; total_amount: SqlNumber; transaction_count: SqlNumber;
  doc_ids: string[] | null; func: string | null; late: string | null;
}
interface PriorYearRow extends Record<string, unknown> {
  bucket: string; total_amount: SqlNumber; transaction_count: SqlNumber;
  doc_ids: string[] | null; func: string | null; late: string | null;
}
interface CommitmentRow extends Record<string, unknown> {
  kind: string; bucket: string; amount: SqlNumber; func: string | null; late: string | null;
}
interface SpenderRow extends Record<string, unknown> {
  employee_id: string; employee_name: string; current_spend: SqlNumber; prior_spend: SqlNumber;
  report_count: SqlNumber; current_ids: string[] | null; prior_ids: string[] | null; func: string | null;
  late_cur: string | null; late_prior: string | null;
}
interface ExpenseCategoryRow extends Record<string, unknown> {
  category_id: string; category_name: string | null; current_amount: SqlNumber; prior_amount: SqlNumber;
  func: string | null; late_cur: string | null; late_prior: string | null;
}
interface ComparisonRow extends Record<string, unknown> {
  account_id: string; account_name: string | null; current_amount: SqlNumber; prior_amount: SqlNumber; two_back_amount: SqlNumber;
  func: string | null; late_cur: string | null; late_prior: string | null; late_two: string | null;
}

// ---- main -------------------------------------------------------------------

export async function spendVelocityData(
  orgId: string,
  period: { from: string; to: string; label: string },
  allowed: ReadonlySet<string> | null,
  strings: SpendVelocityStrings = spendVelocityStrings(englishCatalogMessage, "en"),
): Promise<SpendVelocityData> {
  const { money } = await getMoneyFormatter(orgId)
  const { from, to } = period;
  const C = await analyticsConfig(orgId, "spendVelocity");
  const buckets = await fiscalBucketScope(orgId);

  // Period windows for comparison (inclusive current and back-to-back prior).
  const { priorFrom, priorTo, twoBackFrom, twoBackTo } = getSpendVelocityComparisonWindows(from, to);
  // Prior YEAR window for YoY trends.
  const pyFrom = addMonthsClamped(from, -12);
  const pyTo = addMonthsClamped(to, -12);

  const spendKindsIn = sql.join(SPEND_KINDS.map((k) => sql`${k}`), sql`, `);
  // The spend base: expense/COGS journal lines sourced from spend documents,
  // plus the line entity's functional currency for presentation translation
  // (legs are stamped functional).
  // Filter on the line's own posting date: the entry is still joined for
  // its source document, but the date no longer has to be reached through
  // it, so the window is a predicate the line index can serve.
  const spendBaseWithSubs = (f: string, t: string) => sql`
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join documents d on d.id = e.source_document_id and d.org_id = e.org_id
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
    ${fiscalBucketJoin(orgId, sql`e.posting_date`, buckets.useFiscal)}
    where l.org_id = ${orgId} and d.voided_at is null
      ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
      ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
      and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
      and d.kind in (${spendKindsIn})
      and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
      and l.posting_date >= ${f} and l.posting_date <= ${t}`;

  const [acctRows, vendRows, pyRows, poSoRows, plOpex, spenderRows, catRows, cmpRows] = await Promise.all([
    // 1. Monthly account spend split by transaction kind (PRIMARY). Legs are
    // stamped in their line entity's functional: aggregate per (account,
    // bucket, functional) and translate below. Document counts ride
    // array_agg unions so multi-line documents still count once. Buckets are
    // the org's fiscal periods when it runs a non-monthly calendar, else
    // calendar months; the calendar month number rides along for seasonality.
    db.execute<AccountSpendRow>(sql`
      select l.account_id, a.name as account_name, a.number as account_number, a.type as account_type,
        ${fiscalBucketKey(sql`e.posting_date`, buckets.useFiscal)} as bucket,
        ${fiscalBucketLabel(sql`e.posting_date`, buckets.useFiscal)} as bucket_label,
        extract(month from e.posting_date)::int as month_num,
        sum(l.amount) filter (where d.kind = 'vendor_bill') as bill_amount,
        sum(l.amount) filter (where d.kind = 'expense_report') as expense_amount,
        sum(l.amount) filter (where d.kind = 'check') as check_amount,
        -sum(l.amount) filter (where d.kind = 'vendor_credit') as credit_amount,
        sum(l.amount) as total_amount,
        array_agg(distinct d.id) as doc_ids,
        sub.base_currency as func,
        max(l.posting_date)::text as late
      ${spendBaseWithSubs(from, to)}
      group by 1, 2, 3, 4, 5, 6, 7, sub.base_currency
    `),
    // 2. Monthly vendor/party spend (drill-down).
    db.execute<VendorSpendRow>(sql`
      select d.party_id as vendor_id, coalesce(p.display_name, 'Unknown') as vendor_name,
        ${fiscalBucketKey(sql`e.posting_date`, buckets.useFiscal)} as bucket,
        ${fiscalBucketLabel(sql`e.posting_date`, buckets.useFiscal)} as bucket_label,
        sum(l.amount) as total_amount,
        array_agg(distinct d.id) as doc_ids,
        sub.base_currency as func,
        max(l.posting_date)::text as late
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      ${fiscalBucketJoin(orgId, sql`e.posting_date`, buckets.useFiscal)}
      where l.org_id = ${orgId} and d.voided_at is null
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
        and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
        and d.kind in (${spendKindsIn})
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${from} and e.posting_date <= ${to}
        and d.party_id is not null
      group by 1, 2, 3, 4, sub.base_currency
    `),
    // 3. Prior-YEAR buckets for YoY, keyed by the full bucket identity so a
    // window longer than twelve months can never collide two Januarys.
    db.execute<PriorYearRow>(sql`
      select ${fiscalBucketKey(sql`e.posting_date`, buckets.useFiscal)} as bucket, sum(l.amount) as total_amount,
        array_agg(distinct d.id) as doc_ids, sub.base_currency as func,
        max(l.posting_date)::text as late
      ${spendBaseWithSubs(pyFrom, pyTo)}
      group by 1, sub.base_currency
    `),
    // 4. PO vs SO monthly (commitment cliff). Unposted document totals are
    // transaction currency: translate txn→presentation directly at each
    // bucket's latest document date (same basis as the open-PO tile).
    db.execute<CommitmentRow>(sql`
      select kind, ${fiscalBucketKey(sql`document_date`, buckets.useFiscal)} as bucket, sum(total) as amount,
        currency as func, max(document_date)::text as late
      from documents
      ${fiscalBucketJoin(orgId, sql`document_date`, buckets.useFiscal)}
      where org_id = ${orgId} and kind in ('purchase_order', 'sales_order') and voided_at is null
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)}
        and document_date >= ${from} and document_date <= ${to}
      group by 1, 2, 4
    `),
    // 5. P&L operating expenses + revenue for the OpEx ratio — the shared
    // operating-expenses reader, so this page reports the same "Operating
    // expenses … of revenue" figure as Financial Health. The
    // spend-document universe above (COGS included, non-spend journals
    // missed) is not operating expenses and must not feed this ratio.
    periodOperatingExpenses(orgId, from, to, allowed),
    // (Drill-down detail is fetched per entity on click via /api/analytics/drill.)
    // 7. Top spenders use the same primary-book base-currency actuals as
    // the expense summary; draft headers and transaction totals are not GL spend.
    db.execute<SpenderRow>(sql`
      select d.party_id as employee_id,
        coalesce((select p.display_name from parties p where p.id = d.party_id and p.org_id = d.org_id), 'Unknown') as employee_name,
        sub.base_currency as func,
        sum(l.amount) filter (where e.posting_date >= ${from}) as current_spend,
        sum(l.amount) filter (where e.posting_date < ${from}) as prior_spend,
        array_agg(distinct d.id) filter (where e.posting_date >= ${from}) as current_ids,
        array_agg(distinct d.id) filter (where e.posting_date < ${from}) as prior_ids,
        max(e.posting_date) filter (where e.posting_date >= ${from})::text as late_cur,
        max(e.posting_date) filter (where e.posting_date < ${from})::text as late_prior
      ${spendBaseWithSubs(priorFrom, to)}
        and d.kind = 'expense_report'
      group by 1, 2, sub.base_currency
    `),
    // 8. Expense categories (accounts on expense reports + bills), current vs prior.
    db.execute<ExpenseCategoryRow>(sql`
      select l.account_id as category_id, a.name as category_name,
        sub.base_currency as func,
        sum(l.amount) filter (where e.posting_date >= ${from}) as current_amount,
        sum(l.amount) filter (where e.posting_date < ${from}) as prior_amount,
        max(e.posting_date) filter (where e.posting_date >= ${from})::text as late_cur,
        max(e.posting_date) filter (where e.posting_date < ${from})::text as late_prior
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} and d.voided_at is null
        ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowed)}
        ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowed)}
        and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
        and d.kind in ('expense_report', 'vendor_bill')
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${priorFrom} and e.posting_date <= ${to}
      group by 1, 2, sub.base_currency
    `),
    // 9. Period comparison: current vs prior vs two-back per account.
    db.execute<ComparisonRow>(sql`
      select l.account_id, a.name as account_name, sub.base_currency as func,
        sum(l.amount) filter (where e.posting_date >= ${from}) as current_amount,
        sum(l.amount) filter (where e.posting_date >= ${priorFrom} and e.posting_date < ${from}) as prior_amount,
        sum(l.amount) filter (where e.posting_date >= ${twoBackFrom} and e.posting_date < ${priorFrom}) as two_back_amount,
        max(e.posting_date) filter (where e.posting_date >= ${from})::text as late_cur,
        max(e.posting_date) filter (where e.posting_date >= ${priorFrom} and e.posting_date < ${from})::text as late_prior,
        max(e.posting_date) filter (where e.posting_date >= ${twoBackFrom} and e.posting_date < ${priorFrom})::text as late_two
      ${spendBaseWithSubs(twoBackFrom, to)}
      group by 1, 2, sub.base_currency
    `),
  ]);

  // ---- presentation translation ---------------------------------------------
  // Every leg below arrives in its line entity's functional currency (or the
  // document's transaction currency for unposted commitments). Translate each
  // leg at its latest posting/document date and merge to the original grain
  // in presentation, so the whole velocity engine downstream — CAGR series,
  // detectors, YoY, cliff, comparisons — runs in one currency. Document
  // counts union across legs so multi-line documents still count once, and
  // the old `having sum > 0` filters re-apply on merged bucket totals.
  // Missing rate coverage fails closed.
  const ZERO = "0";
  const asDate = (v: unknown, fallback: string): string => String(v ?? fallback).slice(0, 10);
  const unionIds = (...sets: (readonly string[] | null | undefined)[]): number =>
    new Set(sets.flatMap((s) => [...(s ?? [])])).size;
  const bucketLabelOf = (bucket: string, label: string | null): string =>
    label ?? (buckets.useFiscal ? bucket : strings.monthLabel(bucket.slice(0, 7)));
  const acctCtx = await flowRates(orgId, acctRows.rows.map((r) => ({ func: r.func ?? null, date: asDate(r.late, to) })));
  const acctMerged = new Map<string, AccountSpendRow>();
  for (const r of acctRows.rows) {
    const key = `${r.account_id} ${r.bucket}`;
    const date = asDate(r.late, to);
    const tr = (v: SqlNumber): string => mulDecimal(String(v ?? 0), acctCtx.rateAt(r.func ?? null, date));
    const cur = acctMerged.get(key);
    if (!cur) {
      acctMerged.set(key, { ...r, bill_amount: tr(r.bill_amount), expense_amount: tr(r.expense_amount), check_amount: tr(r.check_amount), credit_amount: tr(r.credit_amount), total_amount: tr(r.total_amount) });
    } else {
      cur.bill_amount = add(String(cur.bill_amount ?? 0), tr(r.bill_amount));
      cur.expense_amount = add(String(cur.expense_amount ?? 0), tr(r.expense_amount));
      cur.check_amount = add(String(cur.check_amount ?? 0), tr(r.check_amount));
      cur.credit_amount = add(String(cur.credit_amount ?? 0), tr(r.credit_amount));
      cur.total_amount = add(String(cur.total_amount ?? 0), tr(r.total_amount));
      cur.doc_ids = [...new Set([...(cur.doc_ids ?? []), ...((r.doc_ids ?? []) as string[])])];
    }
  }
  const acctFinal: AccountSpendRow[] = [...acctMerged.values()].map((r) => ({
    ...r,
    transaction_count: unionIds(r.doc_ids),
  })).filter((r) => cmp(String(r.total_amount ?? 0), ZERO) > 0);

  const vendCtx = await flowRates(orgId, vendRows.rows.map((r) => ({ func: r.func ?? null, date: asDate(r.late, to) })));
  const vendMerged = new Map<string, VendorSpendRow>();
  for (const r of vendRows.rows) {
    const key = `${r.vendor_id} ${r.bucket}`;
    const date = asDate(r.late, to);
    const tr = (v: SqlNumber): string => mulDecimal(String(v ?? 0), vendCtx.rateAt(r.func ?? null, date));
    const cur = vendMerged.get(key);
    if (!cur) {
      vendMerged.set(key, { ...r, total_amount: tr(r.total_amount) });
    } else {
      cur.total_amount = add(String(cur.total_amount ?? 0), tr(r.total_amount));
      cur.doc_ids = [...new Set([...(cur.doc_ids ?? []), ...((r.doc_ids ?? []) as string[])])];
    }
  }
  const vendFinal: VendorSpendRow[] = [...vendMerged.values()].map((r) => ({
    ...r,
    transaction_count: unionIds(r.doc_ids),
  })).filter((r) => cmp(String(r.total_amount ?? 0), ZERO) > 0);

  const pyCtx = await flowRates(orgId, pyRows.rows.map((r) => ({ func: r.func ?? null, date: asDate(r.late, pyTo) })));
  const pyMerged = new Map<string, PriorYearRow>();
  for (const r of pyRows.rows) {
    const key = String(r.bucket);
    const date = asDate(r.late, pyTo);
    const cur = pyMerged.get(key);
    const translated = mulDecimal(String(r.total_amount ?? 0), pyCtx.rateAt(r.func ?? null, date));
    if (!cur) {
      pyMerged.set(key, { ...r, total_amount: translated });
    } else {
      cur.total_amount = add(String(cur.total_amount ?? 0), translated);
      cur.doc_ids = [...new Set([...(cur.doc_ids ?? []), ...((r.doc_ids ?? []) as string[])])];
    }
  }
  const pyByBucket = new Map<string, { amount: string; txns: number }>();
  for (const [key, r] of pyMerged) {
    pyByBucket.set(key, { amount: String(r.total_amount ?? 0), txns: unionIds(r.doc_ids) });
  }
  // Prior-bucket lookup: the same calendar month a year earlier, or the same
  // fiscal period number in the prior fiscal year. A missing prior bucket is
  // unknown history, never zero.
  const priorBucketKey = buckets.useFiscal
    ? (() => {
        const byPeriod = new Map(buckets.periods.map((p) => [`${p.fiscalYear}:${p.periodNumber}`, p.from]));
        return (bucket: string): string | null => {
          const cur = buckets.periods.find((p) => p.from === bucket);
          if (!cur) return null;
          return byPeriod.get(`${cur.fiscalYear - 1}:${cur.periodNumber}`) ?? null;
        };
      })()
    : (bucket: string): string | null => addMonthsClamped(`${bucket}-01`, -12).slice(0, 7);

  // ---- account velocity (primary) -------------------------------------------
  interface AcctAgg {
    id: string; name: string; buckets: { bucket: string; label: string; monthNum: number; amount: string; bill: string; expense: string; other: string; txns: number }[];
    totalSpend: string; totalBills: string; totalExpenses: string; totalOther: string; txns: number;
  }
  const acctMap = new Map<string, AcctAgg>();
  for (const r of acctFinal) {
    let a = acctMap.get(r.account_id);
    if (!a) {
      a = { id: r.account_id, name: strings.displayAccountName(r.account_name, r.account_id), buckets: [], totalSpend: ZERO, totalBills: ZERO, totalExpenses: ZERO, totalOther: ZERO, txns: 0 };
      acctMap.set(r.account_id, a);
    }
    const amount = String(r.total_amount ?? 0);
    const bill = String(r.bill_amount ?? 0);
    const expense = String(r.expense_amount ?? 0);
    const other = add(String(r.check_amount ?? 0), neg(String(r.credit_amount ?? 0)));
    a.buckets.push({ bucket: r.bucket, label: bucketLabelOf(r.bucket, r.bucket_label), monthNum: Number(r.month_num), amount, bill, expense, other, txns: Number(r.transaction_count ?? 0) });
    a.totalSpend = add(a.totalSpend, amount);
    a.totalBills = add(a.totalBills, bill);
    a.totalExpenses = add(a.totalExpenses, expense);
    a.totalOther = add(a.totalOther, other);
    a.txns += Number(r.transaction_count ?? 0);
  }

  const accountVelocity: VelocityRow[] = [...acctMap.values()].filter((a) => a.buckets.length > 0).map((a) => {
    a.buckets.sort((x, y) => x.bucket.localeCompare(y.bucket));
    // Rate math crosses into numbers once per bucket; every money figure
    // above and below stays an exact decimal string.
    const amounts = a.buckets.map((m) => toChartNumber(m.amount));
    const { velocity, acceleration, trend } = velocityAndAcceleration(amounts, C);
    const total = toChartNumber(a.totalSpend);
    return {
      id: a.id,
      name: a.name,
      entityType: "account" as const,
      totalSpend: a.totalSpend,
      totalBills: a.totalBills,
      totalExpenses: a.totalExpenses,
      totalOther: a.totalOther,
      billPct: total > 0 ? Math.round((toChartNumber(a.totalBills) / total) * 100) : 0,
      expensePct: total > 0 ? Math.round((toChartNumber(a.totalExpenses) / total) * 100) : 0,
      transactionCount: a.txns,
      monthCount: a.buckets.length,
      velocity,
      acceleration,
      trend,
      latestSpend: a.buckets[a.buckets.length - 1]?.amount ?? ZERO,
      previousSpend: a.buckets.length > 1 ? a.buckets[a.buckets.length - 2]!.amount : ZERO,
      avgMonthlySpend: div(a.totalSpend, String(Math.max(1, a.buckets.length))),
      monthlyAmounts: amounts,
      monthLabels: a.buckets.map((m) => m.label),
    };
  }).sort((x, y) => cmp(y.totalSpend, x.totalSpend));

  // ---- vendor velocity (drill-down) ------------------------------------------
  interface VendAgg { id: string; name: string; buckets: { bucket: string; label: string; amount: string; txns: number }[]; totalSpend: string; txns: number }
  const vendMap = new Map<string, VendAgg>();
  for (const r of vendFinal) {
    let v = vendMap.get(r.vendor_id);
    if (!v) { v = { id: r.vendor_id, name: strings.displayPartyName(String(r.vendor_name)), buckets: [], totalSpend: ZERO, txns: 0 }; vendMap.set(r.vendor_id, v); }
    const amount = String(r.total_amount ?? 0);
    v.buckets.push({ bucket: r.bucket, label: bucketLabelOf(r.bucket, r.bucket_label), amount, txns: Number(r.transaction_count ?? 0) });
    v.totalSpend = add(v.totalSpend, amount);
    v.txns += Number(r.transaction_count ?? 0);
  }
  const allVendors = [...vendMap.values()].filter((v) => v.buckets.length > 0).map((v) => {
    v.buckets.sort((x, y) => x.bucket.localeCompare(y.bucket));
    const amounts = v.buckets.map((m) => toChartNumber(m.amount));
    const { velocity, acceleration, trend } = velocityAndAcceleration(amounts, C);
    return {
      id: v.id, name: v.name, entityType: "vendor" as const,
      totalSpend: v.totalSpend, totalBills: ZERO, totalExpenses: ZERO, totalOther: ZERO, billPct: 0, expensePct: 0,
      transactionCount: v.txns, monthCount: v.buckets.length,
      velocity, acceleration, trend,
      latestSpend: v.buckets[v.buckets.length - 1]?.amount ?? ZERO,
      previousSpend: v.buckets.length > 1 ? v.buckets[v.buckets.length - 2]!.amount : ZERO,
      avgMonthlySpend: div(v.totalSpend, String(Math.max(1, v.buckets.length))),
      monthlyAmounts: amounts, monthLabels: v.buckets.map((m) => m.label),
    };
  }).sort((x, y) => cmp(y.totalSpend, x.totalSpend));
  const vendorVelocity = allVendors.slice(0, C.topVendorsCount);

  // ---- transaction-type velocity (bills vs expense reports) ------------------
  const typeMonthly = new Map<string, { bill: string; expense: string }>();
  for (const a of acctMap.values()) {
    for (const m of a.buckets) {
      const t = typeMonthly.get(m.bucket) ?? { bill: ZERO, expense: ZERO };
      t.bill = add(t.bill, m.bill); t.expense = add(t.expense, m.expense);
      typeMonthly.set(m.bucket, t);
    }
  }
  const typeBuckets = [...typeMonthly.keys()].sort();
  const billsSeries = typeBuckets.map((b) => toChartNumber(typeMonthly.get(b)!.bill));
  const expSeries = typeBuckets.map((b) => toChartNumber(typeMonthly.get(b)!.expense));
  const billsTotal = [...typeMonthly.values()].reduce((s, t) => add(s, t.bill), ZERO);
  const expensesTotal = [...typeMonthly.values()].reduce((s, t) => add(s, t.expense), ZERO);
  const billsVelocity = r1(velocityCAGR(billsSeries, C.minBaseAmount));
  const expensesVelocity = r1(velocityCAGR(expSeries, C.minBaseAmount));

  // ---- anomalies (z-score, verbatim) -----------------------------------------
  const anomalyCritical = C.anomalyStdDevThreshold + C.anomalyCriticalOffset;
  const anomalyItems: SVAnomaly[] = [];
  for (const a of acctMap.values()) {
    if (a.buckets.length < 3) continue;
    const amounts = a.buckets.map((m) => toChartNumber(m.amount));
    const mean = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    const stdDev = Math.sqrt(amounts.reduce((s, v) => s + (v - mean) ** 2, 0) / amounts.length);
    if (stdDev === 0) continue;
    const exactMean = div(a.buckets.reduce((s, m) => add(s, m.amount), ZERO), String(amounts.length));
    for (let i = 0; i < a.buckets.length; i++) {
      const z = (amounts[i]! - mean) / stdDev;
      if (Math.abs(z) >= C.anomalyStdDevThreshold) {
        anomalyItems.push({
          accountId: a.id, accountName: a.name, month: a.buckets[i]!.label, amount: a.buckets[i]!.amount, expectedAmount: exactMean,
          deviation: mean !== 0 ? Math.round(((amounts[i]! - mean) / mean) * 100) : 0, zScore: r1(z),
          type: z > 0 ? "spike" : "drop", severity: Math.abs(z) >= anomalyCritical ? "critical" : "warning",
        });
      }
    }
  }
  anomalyItems.sort((x, y) => Math.abs(y.zScore) - Math.abs(x.zScore));
  const anomalies = {
    summary: {
      count: anomalyItems.length,
      spikeCount: anomalyItems.filter((x) => x.type === "spike").length,
      dropCount: anomalyItems.filter((x) => x.type === "drop").length,
      criticalCount: anomalyItems.filter((x) => x.severity === "critical").length,
    },
    items: anomalyItems.slice(0, 30),
  };

  // ---- monthly trends w/ YoY ---------------------------------------------------
  const trendMap = new Map<string, { label: string; total: string; txns: number; bill: string; expense: string; vendors: Set<string> }>();
  for (const a of acctMap.values()) {
    for (const m of a.buckets) {
      let t = trendMap.get(m.bucket);
      if (!t) { t = { label: m.label, total: ZERO, txns: 0, bill: ZERO, expense: ZERO, vendors: new Set() }; trendMap.set(m.bucket, t); }
      t.total = add(t.total, m.amount); t.txns += m.txns; t.bill = add(t.bill, m.bill); t.expense = add(t.expense, m.expense);
    }
  }
  for (const r of vendRows.rows) {
    const t = trendMap.get(r.bucket);
    if (t) {
      // Vendor legs arrive per functional; the account map already holds the
      // translated total, so only the distinct vendor count rides this pass.
      t.vendors.add(r.vendor_id);
    }
  }
  const monthlyTrends = [...trendMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([bucket, t], i, arr) => {
    const priorKey = priorBucketKey(bucket);
    const py = priorKey ? pyByBucket.get(priorKey) : undefined;
    const prev = i > 0 ? arr[i - 1]![1].total : ZERO;
    const total = toChartNumber(t.total);
    const prevNum = toChartNumber(prev);
    const pyAmount = py?.amount ?? ZERO;
    return {
      month: bucket,
      label: t.label,
      totalAmount: t.total,
      transactionCount: t.txns,
      billAmount: t.bill,
      expenseAmount: t.expense,
      vendorCount: t.vendors.size,
      priorYearAmount: pyAmount,
      yoyChange: py && cmp(py.amount, ZERO) > 0 ? Math.round(((total - toChartNumber(py.amount)) / toChartNumber(py.amount)) * 1000) / 10 : null,
      velocity: i > 0 && cmp(prev, ZERO) > 0 ? Math.round(((total - prevNum) / prevNum) * 1000) / 10 : null,
    };
  });

  // ---- seasonal patterns --------------------------------------------------------
  // Seasonality is a calendar-month phenomenon (holiday peaks), not a fiscal
  // one: buckets always fold back to their calendar month here.
  const monthNames = strings.shortMonths;
  const seasonTotals = new Map<number, string>();
  for (const a of acctMap.values()) {
    for (const m of a.buckets) {
      seasonTotals.set(m.monthNum, add(seasonTotals.get(m.monthNum) ?? ZERO, m.amount));
    }
  }
  const seasonVals = [...seasonTotals.values()].map(toChartNumber);
  const seasonAvg = seasonVals.length ? seasonVals.reduce((s, v) => s + v, 0) / seasonVals.length : 0;
  const patterns = Array.from({ length: 12 }, (_, i) => {
    const total = seasonTotals.get(i + 1) ?? ZERO;
    const totalNum = toChartNumber(total);
    const deviation = seasonAvg > 0 ? Math.round(((totalNum - seasonAvg) / seasonAvg) * 100) : 0;
    return { month: i + 1, monthName: monthNames[i]!, totalSpend: total, deviation, isHigh: deviation > C.seasonalBand, isLow: deviation < -C.seasonalBand };
  });
  const seasonalInsights: { type: string; message: string }[] = [];
  const highMonths = patterns.filter((p) => p.isHigh);
  const lowMonths = patterns.filter((p) => p.isLow);
  if (highMonths.length) seasonalInsights.push({ type: "high_season", message: strings.seasonalHigh(highMonths.map((m) => m.monthName)) });
  if (lowMonths.length) seasonalInsights.push({ type: "low_season", message: strings.seasonalLow(lowMonths.map((m) => m.monthName)) });

  // ---- boiling frog ---------------------------------------------------------------
  const frogAccounts: SpendVelocityData["boilingFrog"]["accounts"] = [];
  for (const a of acctMap.values()) {
    if (a.buckets.length < C.boilingFrogMonths) continue;
    const amounts = a.buckets.map((m) => toChartNumber(m.amount));
    let increases = 0, totalCreep = 0;
    for (let i = 1; i < amounts.length; i++) {
      const prev = amounts[i - 1]!, curr = amounts[i]!;
      if (prev > 0) {
        const pct = ((curr - prev) / prev) * 100;
        if (pct > 0 && pct <= C.boilingFrogStepCap) { increases++; totalCreep += pct; }
      }
    }
    const monotonicRatio = (increases / (amounts.length - 1)) * 100;
    if (monotonicRatio >= C.boilingFrogMonotonicRatio && totalCreep >= C.boilingFrogMinIncrease) {
      const startAmount = a.buckets[0]!.amount;
      const endAmount = a.buckets[a.buckets.length - 1]!.amount;
      const monthCount = a.buckets.length;
      frogAccounts.push({
        accountId: a.id, accountName: a.name,
        monotonicRatio: Math.round(monotonicRatio),
        avgMonthlyIncrease: increases > 0 ? r1(totalCreep / increases) : 0,
        totalCreep: Math.round(totalCreep),
        startAmount, endAmount, monthCount,
        annualizedCreep: div(mulDecimal(add(endAmount, neg(startAmount)), "12"), String(monthCount)),
        monthlyAmounts: amounts,
        severity: totalCreep > C.boilingFrogCriticalCreep ? "critical" : totalCreep > C.boilingFrogWarningCreep ? "warning" : "info",
      });
    }
  }
  frogAccounts.sort((x, y) => y.totalCreep - x.totalCreep);
  const boilingFrog = {
    summary: {
      count: frogAccounts.length,
      criticalCount: frogAccounts.filter((x) => x.severity === "critical").length,
      totalAnnualizedCreep: frogAccounts.reduce((s, x) => add(s, x.annualizedCreep), ZERO),
    },
    accounts: frogAccounts.slice(0, 20),
  };

  // ---- concentration risk (HHI) ----------------------------------------------------
  const totalSpend = accountVelocity.reduce((s, a) => add(s, a.totalSpend), ZERO);
  const totalSpendNum = toChartNumber(totalSpend);
  const withShares = accountVelocity.map((a) => ({ ...a, spendShare: totalSpendNum > 0 ? (toChartNumber(a.totalSpend) / totalSpendNum) * 100 : 0 }));
  const hhi = withShares.reduce((s, a) => s + a.spendShare ** 2, 0);
  const concentration = {
    summary: {
      hhi: Math.round(hhi),
      hhiStatus: hhi > C.hhiCritical ? "concentrated" : hhi > C.hhiWarning ? "moderate" : "diversified",
      top1Share: r1(withShares[0]?.spendShare ?? 0),
      top5Share: r1(withShares.slice(0, 5).reduce((s, a) => s + a.spendShare, 0)),
      top10Share: r1(withShares.slice(0, 10).reduce((s, a) => s + a.spendShare, 0)),
      riskAccountCount: withShares.filter((a) => a.spendShare > C.concentrationShareThreshold && (a.trend === "accelerating" || a.trend === "high")).length,
    },
    accounts: withShares.filter((a) => a.spendShare > C.concentrationShareThreshold && (a.trend === "accelerating" || a.trend === "high")).slice(0, 10),
  };

  // ---- zombie subscriptions -----------------------------------------------------------
  const zombieList: SpendVelocityData["zombies"]["subscriptions"] = [];
  for (const v of vendMap.values()) {
    if (v.buckets.length < C.zombieMinMonths) continue;
    const amounts = v.buckets.map((m) => m.amount);
    const first = amounts[0]!;
    let isZombie = amounts.every((x) => cmp(x, first) === 0);
    if (!isZombie) {
      const nums = amounts.map(toChartNumber);
      const mean = nums.reduce((s, x) => s + x, 0) / nums.length;
      const maxDev = Math.max(...nums.map((x) => Math.abs(x - mean)));
      isZombie = mean > 0 && (maxDev / mean) * 100 < C.zombieMaxDeviation;
    }
    if (isZombie && cmp(first, ZERO) > 0) {
      zombieList.push({
        vendorId: v.id, vendorName: v.name, amount: first, monthCount: v.buckets.length,
        annualCost: mulDecimal(first, "12"), firstMonth: v.buckets[0]!.bucket, lastMonth: v.buckets[v.buckets.length - 1]!.bucket,
        severity: v.buckets.length >= C.zombieCriticalMonths ? "critical" : "warning",
      });
    }
  }
  zombieList.sort((x, y) => cmp(y.annualCost, x.annualCost));
  const zombies = {
    summary: {
      count: zombieList.length,
      criticalCount: zombieList.filter((z) => z.severity === "critical").length,
      totalAnnualCost: zombieList.reduce((s, z) => add(s, z.annualCost), ZERO),
    },
    subscriptions: zombieList.slice(0, 20),
  };

  // ---- category fragmentation -----------------------------------------------------------
  // The score is a unitless ratio product: how many times over the count
  // floor the category runs, times how far under the configured size cap its
  // average sits. Averages in any currency score identically.
  const fragCap = C.fragmentationMaxAvgSize;
  const fragList: SpendVelocityData["fragmentation"]["categories"] = [];
  if (fragCap !== "") {
    for (const a of acctMap.values()) {
      const avgTxnSize = a.txns > 0 ? div(a.totalSpend, String(a.txns)) : ZERO;
      const txnsPerMonth = a.buckets.length > 0 ? a.txns / a.buckets.length : 0;
      if (txnsPerMonth > C.fragmentationMinTxns && cmp(avgTxnSize, fragCap) < 0 && cmp(avgTxnSize, ZERO) > 0) {
        fragList.push({
          accountId: a.id, accountName: a.name, totalSpend: a.totalSpend, transactionCount: a.txns,
          avgTransactionSize: avgTxnSize, txnsPerMonth: Math.round(txnsPerMonth),
          fragmentationScore: (txnsPerMonth / C.fragmentationMinTxns) * Number(div(fragCap, avgTxnSize)),
        });
      }
    }
  }
  fragList.sort((x, y) => y.fragmentationScore - x.fragmentationScore);
  const fragmentation = {
    summary: {
      fragmentedCategories: fragList.length,
      totalFragmentedSpend: fragList.reduce((s, f) => add(s, f.totalSpend), ZERO),
      configured: fragCap !== "",
      reason: fragCap !== "" ? "" : strings.fragmentationUnconfigured,
    },
    categories: fragList.slice(0, 15),
  };

  // ---- shadow IT — honest gap -------------------------------------------------------------
  const shadowIT = {
    available: false as const,
    reason: strings.shadowItReason,
  };

  // ---- commitment cliff ----------------------------------------------------------------------
  const commitCtx = await flowRates(orgId, poSoRows.rows.map((r) => ({
    func: (r.func ?? null) as string | null, date: asDate(r.late, to),
  })));
  const cliffMonths = new Map<string, { po: string; so: string }>();
  for (const r of poSoRows.rows) {
    const m = cliffMonths.get(r.bucket) ?? { po: "0.0000", so: "0.0000" };
    const rate = commitCtx.rateAt((r.func ?? null) as string | null, asDate(r.late, to));
    const amount = mulDecimal(String(r.amount ?? 0), rate);
    if (r.kind === "purchase_order") m.po = add(m.po, amount);
    else m.so = add(m.so, amount);
    cliffMonths.set(r.bucket, m);
  }
  const cliffSeries = [...cliffMonths.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, v]) => ({ month: bucket, poAmount: v.po, soAmount: v.so }));
  // A short history suppresses growth estimates, not the observed commitments.
  const poCagr = moneyCagr(cliffSeries.map((m) => m.poAmount), C.minBaseAmount);
  const soCagr = moneyCagr(cliffSeries.map((m) => m.soAmount), C.minBaseAmount);
  const poVelocity = poCagr === null ? null : Math.round(poCagr);
  const soVelocity = soCagr === null ? null : Math.round(soCagr);
  const velocityGap = poVelocity === null || soVelocity === null ? null : poVelocity - soVelocity;
  const totalPO = cliffSeries.reduce((s, m) => add(s, m.poAmount), "0.0000");
  const totalSO = cliffSeries.reduce((s, m) => add(s, m.soAmount), "0.0000");
  const hasSales = cmp(totalSO, ZERO) > 0;
  const ratio = hasSales ? Math.round(toChartNumber(div(totalPO, totalSO)) * 100) / 100 : 0;
  let status: "healthy" | "warning" | "critical" = "healthy";
  let monthsToCliff: number | null = null;
  const gap = velocityGap;
  if ((gap !== null && gap > C.cliffCriticalGap) || ratio > C.cliffCriticalRatio) {
    status = "critical";
    if (gap !== null && hasSales) monthsToCliff = monthsToCliffFor(gap, ratio, C.cliffCriticalRatio);
  } else if ((gap !== null && gap > C.cliffWarningGap) || ratio > C.cliffWarningRatio) {
    status = "warning";
    if (gap !== null && hasSales) monthsToCliff = monthsToCliffFor(gap, ratio, C.cliffWarningRatio);
  }
  const commitmentCliff: SpendVelocityData["commitmentCliff"] = { summary: { poVelocity, soVelocity, velocityGap, ratio, status, monthsToCliff, totalPO, totalSO }, months: cliffSeries };

  // ---- revenue normalisation ---------------------------------------------------------------------
  // The OpEx ratio reads the shared P&L operating-expenses reader (true OpEx
  // over true revenue), never the spend-document total above: that universe
  // mixes a COGS account in and drops genuine expense.
  const totalRevenue = plOpex.revenue;
  const revenue = {
    hasData: cmp(totalRevenue, ZERO) > 0,
    totalRevenue,
    opexRatio: operatingExpenseRatio(plOpex.opex, totalRevenue),
  };

  // ---- period comparison ------------------------------------------------------------------------------
  // Comparison legs translate per (account, functional) at each window's
  // latest posting date, then merge in presentation.
  const cmpCtx = await flowRates(orgId, [
    ...cmpRows.rows.map((r) => ({ func: r.func ?? null, date: asDate(r.late_cur, to) })),
    ...cmpRows.rows.filter((r) => r.prior_amount != null).map((r) => ({ func: r.func ?? null, date: asDate(r.late_prior, priorFrom) })),
    ...cmpRows.rows.filter((r) => r.two_back_amount != null).map((r) => ({ func: r.func ?? null, date: asDate(r.late_two, twoBackFrom) })),
  ]);
  const cmpByAccount = new Map<string, { name: string; current: string; prior: string; twoBack: string }>();
  for (const r of cmpRows.rows) {
    const cur = cmpByAccount.get(r.account_id) ?? { name: strings.displayAccountName(String(r.account_name ?? ""), r.account_id), current: ZERO, prior: ZERO, twoBack: ZERO };
    cur.current = add(cur.current, mulDecimal(String(r.current_amount ?? 0), cmpCtx.rateAt(r.func ?? null, asDate(r.late_cur, to))));
    if (r.prior_amount != null) {
      cur.prior = add(cur.prior, mulDecimal(String(r.prior_amount), cmpCtx.rateAt(r.func ?? null, asDate(r.late_prior, priorFrom))));
    }
    if (r.two_back_amount != null) {
      cur.twoBack = add(cur.twoBack, mulDecimal(String(r.two_back_amount), cmpCtx.rateAt(r.func ?? null, asDate(r.late_two, twoBackFrom))));
    }
    cmpByAccount.set(r.account_id, cur);
  }
  const capAccount = C.projectionCapAccount / 100;
  const cmpAccounts = [...cmpByAccount.entries()].map(([accountId, c]) => {
    const current = c.current;
    const prior = c.prior;
    const twoBack = c.twoBack;
    const priorPositive = cmp(prior, ZERO) > 0;
    const twoBackPositive = cmp(twoBack, ZERO) > 0;
    // No prior-window history (mid-year go-live, new account): change is
    // UNKNOWN, never a fabricated +100% against a zero base.
    const changePct: number | null = priorPositive
      ? r1(toChartNumber(div(add(current, neg(prior)), prior)) * 100)
      : null;
    const curNum = toChartNumber(current);
    const priorNum = toChartNumber(prior);
    const twoBackNum = toChartNumber(twoBack);
    let avgChange = 0;
    if (priorPositive && twoBackPositive) avgChange = (curNum / priorNum + priorNum / twoBackNum) / 2 - 1;
    else if (priorPositive) avgChange = curNum / priorNum - 1;
    const clamped = Math.min(Math.max(avgChange, -capAccount), capAccount);
    const vel = accountVelocity.find((a) => a.id === accountId);
    return {
      accountId,
      accountName: c.name,
      currentAmount: current,
      priorAmount: prior,
      twoBackAmount: twoBack,
      changePct,
      projectedAmount: add(current, mulDecimal(current, clamped.toFixed(4))),
      isNew: !priorPositive && cmp(current, ZERO) > 0,
      monthlyTrend: vel?.monthlyAmounts ?? [],
      velocity: vel?.velocity ?? 0,
      acceleration: vel?.acceleration ?? 0,
      trend: vel?.trend ?? "stable",
    };
  }).filter((a) => cmp(a.currentAmount, ZERO) > 0 || cmp(a.priorAmount, ZERO) > 0 || cmp(a.twoBackAmount, ZERO) > 0)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
  const currentTotal = cmpAccounts.reduce((s, a) => add(s, a.currentAmount), ZERO);
  const priorTotal = cmpAccounts.reduce((s, a) => add(s, a.priorAmount), ZERO);
  const twoBackTotal = cmpAccounts.reduce((s, a) => add(s, a.twoBackAmount), ZERO);
  const priorTotalPositive = cmp(priorTotal, ZERO) > 0;
  const overallChange: number | null = priorTotalPositive
    ? r1(toChartNumber(div(add(currentTotal, neg(priorTotal)), priorTotal)) * 100)
    : null;
  const capTotal = C.projectionCapTotal / 100;
  const periodComparison = {
    summary: {
      currentTotal,
      priorTotal,
      twoBackTotal,
      projectedTotal: overallChange === null
        ? currentTotal
        : add(currentTotal, mulDecimal(currentTotal, (overallChange / 100 >= 0
            ? Math.min(overallChange / 100, capTotal)
            : Math.max(overallChange / 100, -capTotal)).toFixed(4))),
      changePct: overallChange,
      priorLabel: `${priorFrom} → ${priorTo}`,
      twoBackLabel: `${twoBackFrom} → ${twoBackTo}`,
    },
    accounts: cmpAccounts,
  };

  // ---- expense analysis ---------------------------------------------------------------------------------------
  // Spender and category legs translate per (entity, functional) at each
  // window's latest posting date, then merge; report counts union. Totals
  // accumulate over every spender and category BEFORE the display slices, so
  // a top-50 list can never shrink the headline figure.
  const spenderCtx = await flowRates(orgId, [
    ...spenderRows.rows.map((r) => ({ func: r.func ?? null, date: asDate(r.late_cur, to) })),
    ...spenderRows.rows.filter((r) => r.prior_spend != null).map((r) => ({ func: r.func ?? null, date: asDate(r.late_prior, priorFrom) })),
  ]);
  const spenderByEmployee = new Map<string, { name: string; current: string; prior: string; ids: Set<string> }>();
  for (const r of spenderRows.rows) {
    const cur = spenderByEmployee.get(r.employee_id) ?? { name: strings.displayPartyName(String(r.employee_name)), current: ZERO, prior: ZERO, ids: new Set<string>() };
    cur.current = add(cur.current, mulDecimal(String(r.current_spend ?? 0), spenderCtx.rateAt(r.func ?? null, asDate(r.late_cur, to))));
    if (r.prior_spend != null) {
      cur.prior = add(cur.prior, mulDecimal(String(r.prior_spend), spenderCtx.rateAt(r.func ?? null, asDate(r.late_prior, priorFrom))));
    }
    for (const id of (r.current_ids ?? []) as string[]) cur.ids.add(id);
    spenderByEmployee.set(r.employee_id, cur);
  }
  const expenseReportTotal = [...spenderByEmployee.values()].reduce((s, x) => add(s, x.current), ZERO);
  // Spender and category amounts stay exact decimal strings to the tool and
  // any reader: chart coordinates are the only place numbers belong.
  const topSpenders = [...spenderByEmployee.entries()].map(([employeeId, s]) => {
    const priorPositive = cmp(s.prior, ZERO) > 0;
    return {
      employeeId,
      employeeName: s.name,
      totalSpend: s.current,
      priorSpend: s.prior,
      reportCount: s.ids.size,
      changePct: priorPositive ? r1(toChartNumber(div(add(s.current, neg(s.prior)), s.prior)) * 100) : null,
    };
  }).filter((s) => cmp(add(s.totalSpend, s.priorSpend), ZERO) > 0 && (cmp(s.totalSpend, ZERO) > 0 || cmp(s.priorSpend, ZERO) > 0))
    .sort((a, b) => cmp(b.totalSpend, a.totalSpend))
    .slice(0, 50);
  let categoryIncreaseTotal = ZERO;
  const catCtx = await flowRates(orgId, [
    ...catRows.rows.map((r) => ({ func: r.func ?? null, date: asDate(r.late_cur, to) })),
    ...catRows.rows.filter((r) => r.prior_amount != null).map((r) => ({ func: r.func ?? null, date: asDate(r.late_prior, priorFrom) })),
  ]);
  const catByAccount = new Map<string, { name: string; current: string; prior: string }>();
  for (const r of catRows.rows) {
    const cur = catByAccount.get(r.category_id) ?? { name: strings.displayAccountName(String(r.category_name ?? ""), r.category_id), current: ZERO, prior: ZERO };
    cur.current = add(cur.current, mulDecimal(String(r.current_amount ?? 0), catCtx.rateAt(r.func ?? null, asDate(r.late_cur, to))));
    if (r.prior_amount != null) {
      cur.prior = add(cur.prior, mulDecimal(String(r.prior_amount), catCtx.rateAt(r.func ?? null, asDate(r.late_prior, priorFrom))));
    }
    catByAccount.set(r.category_id, cur);
  }
  const expCategories = [...catByAccount.entries()].map(([categoryId, c]) => {
    const priorPositive = cmp(c.prior, ZERO) > 0;
    const changePct = priorPositive ? r1(toChartNumber(div(add(c.current, neg(c.prior)), c.prior)) * 100) : null;
    if (changePct !== null && changePct > C.categoryIncreaseThreshold) {
      categoryIncreaseTotal = add(categoryIncreaseTotal, add(c.current, neg(c.prior)));
    }
    return { categoryId, categoryName: c.name, currentAmount: c.current, priorAmount: c.prior, changePct };
  }).filter((c) => cmp(c.currentAmount, ZERO) > 0 || cmp(c.priorAmount, ZERO) > 0)
    .sort((a, b) => cmp(b.currentAmount, a.currentAmount))
    .slice(0, 50);
  const expenseAnalysis = {
    summary: {
      expenseReportTotal,
      vendorBillTotal: billsTotal,
      topSpenderCount: topSpenders.filter((s) => (s.changePct ?? 0) > C.spenderIncreaseThreshold).length,
      categoryIncreaseTotal,
    },
    topSpenders,
    categories: expCategories,
    monthlyTrends: typeBuckets.map((b) => ({ month: b, expenseAmount: typeMonthly.get(b)!.expense, billAmount: typeMonthly.get(b)!.bill })),
  };

  // ---- summary + health score ---------------------------------------------------
  const avgVelocity = accountVelocity.length ? accountVelocity.reduce((s, a) => s + a.velocity, 0) / accountVelocity.length : 0;
  const avgAcceleration = accountVelocity.length ? accountVelocity.reduce((s, a) => s + a.acceleration, 0) / accountVelocity.length : 0;
  const acceleratingCount = accountVelocity.filter((a) => a.trend === "accelerating").length;
  const highVelocityCount = accountVelocity.filter((a) => a.velocity > C.velocityHighThreshold).length;

  let deductions = 0;
  // Velocity health: hot-velocity accounts cost unit points each, capped twice.
  deductions += Math.min(C.healthVelocityCap,
    Math.min(C.healthVelocityUnitCap, highVelocityCount * C.healthVelocityUnit)
    + Math.min(C.healthVelocityUnitCap, acceleratingCount * C.healthVelocityUnit));
  // Critical issues.
  const criticalFrog = boilingFrog.summary.criticalCount;
  const criticalZombies = zombies.summary.criticalCount;
  deductions += Math.min(C.healthCriticalCap,
    Math.min(C.healthCriticalAnomalyCap, anomalies.summary.criticalCount * C.healthCriticalAnomalyUnit)
    + Math.min(C.healthCriticalFrogCap, criticalFrog * C.healthCriticalFrogUnit)
    + Math.min(C.healthCriticalZombieCap, criticalZombies * C.healthCriticalZombieUnit));
  // Warnings.
  deductions += Math.min(C.healthWarningCap,
    Math.min(C.healthWarningAnomalyCap, (anomalies.summary.count - anomalies.summary.criticalCount) * C.healthWarningAnomalyUnit) +
    Math.min(C.healthWarningFrogCap, (boilingFrog.summary.count - criticalFrog) * C.healthWarningFrogUnit) +
    Math.min(C.healthWarningZombieCap, (zombies.summary.count - criticalZombies) * C.healthWarningZombieUnit));
  // Structural risk.
  let structural = 0;
  const top1 = concentration.summary.top1Share;
  if (top1 > C.structuralTop1High) structural += C.structuralTop1HighPoints;
  else if (top1 > C.structuralTop1Medium) structural += C.structuralTop1MediumPoints;
  else if (top1 > C.structuralTop1Low) structural += C.structuralTop1LowPoints;
  structural += Math.min(C.fragmentationUnitCap, fragmentation.summary.fragmentedCategories * C.fragmentationUnitWeight);
  if (commitmentCliff.summary.status === "critical") structural += C.cliffCriticalPoints;
  else if (commitmentCliff.summary.status === "warning") structural += C.cliffWarningPoints;
  deductions += Math.min(C.healthStructuralCap, structural);
  // Financial impact: savings potential as a share of total spend.
  const savingsPotential = add(boilingFrog.summary.totalAnnualizedCreep, zombies.summary.totalAnnualCost);
  if (cmp(totalSpend, ZERO) > 0) {
    const savingsRatio = toChartNumber(div(savingsPotential, totalSpend)) * 100;
    if (savingsRatio > C.savingsRatioCritical) deductions += C.savingsCriticalPoints;
    else if (savingsRatio > C.savingsRatioHigh) deductions += C.savingsHighPoints;
    else if (savingsRatio > C.savingsRatioMedium) deductions += C.savingsMediumPoints;
    else if (savingsRatio > C.savingsRatioLow) deductions += C.savingsLowPoints;
    else if (savingsRatio > C.savingsRatioWatch) deductions += C.savingsWatchPoints;
  }
  const healthScore = Math.round(Math.max(0, Math.min(100, 100 - deductions)));
  const healthGrade = healthScore >= C.healthGradeA ? "A" : healthScore >= C.healthGradeB ? "B" : healthScore >= C.healthGradeC ? "C" : healthScore >= C.healthGradeD ? "D" : "F";

  const totalAlerts = boilingFrog.summary.count + anomalies.summary.count + zombies.summary.count + fragmentation.summary.fragmentedCategories;

  // ---- insights ---------------------------------------------------------------------------------
  const insights: SVInsight[] = [];
  const fmtK = (n: string) => money(n, { maximumFractionDigits: 0 });
  const highVelAlerts = accountVelocity.filter((a) => a.velocity > C.highVelocityAlert);
  if (highVelAlerts.length) insights.push({ type: "alert", ...strings.highGrowth(highVelAlerts.length) });
  if (Math.abs(billsVelocity - expensesVelocity) > C.typeImbalanceGap) {
    insights.push({
      type: "warning",
      ...strings.typeImbalance(
        billsVelocity > expensesVelocity ? "bills" : "expenses",
        Math.abs(Math.round(billsVelocity - expensesVelocity)),
      ),
    });
  }
  if (anomalies.summary.criticalCount > 0) insights.push({ type: "alert", ...strings.anomalies(anomalies.summary.criticalCount) });
  if (boilingFrog.summary.criticalCount > 0) insights.push({ type: "warning", ...strings.creep(boilingFrog.summary.criticalCount) });
  if (concentration.summary.top1Share > C.concentrationTop1Warning) insights.push({ type: "warning", ...strings.concentration(Math.round(concentration.summary.top1Share)) });
  if (zombies.summary.count > 0) insights.push({ type: "info", ...strings.zombies(zombies.summary.count, fmtK(zombies.summary.totalAnnualCost)) });
  if (fragmentation.summary.fragmentedCategories > 0) insights.push({ type: "warning", ...strings.fragmentation(fragmentation.summary.fragmentedCategories) });
  if (revenue.hasData && revenue.opexRatio > C.opexRatioAlert) insights.push({ type: "alert", ...strings.opexRatio(revenue.opexRatio) });
  if (commitmentCliff.summary.status !== "healthy") {
    const c = commitmentCliff.summary;
    const cliffText = strings.cliff(c.poVelocity, c.soVelocity, c.velocityGap, c.ratio);
    insights.push({
      type: c.status === "critical" ? "alert" : "warning",
      title: cliffText.title,
      message: cliffText.message,
      action: strings.cliffAction(c.monthsToCliff),
    });
  }

  return {
    period,
    config: C,
    summary: {
      totalSpend, accountCount: accountVelocity.length,
      avgVelocity: r1(avgVelocity), avgAcceleration: r1(avgAcceleration),
      acceleratingCount, deceleratingCount: accountVelocity.filter((a) => a.trend === "declining").length,
      highVelocityCount, healthScore, healthGrade,
      billsTotal, expensesTotal, billsVelocity, expensesVelocity,
      savingsPotential, totalAlerts,
    },
    accountVelocity,
    vendorVelocity,
    anomalies,
    monthlyTrends,
    seasonal: { patterns, insights: seasonalInsights },
    boilingFrog,
    concentration,
    zombies,
    fragmentation,
    shadowIT,
    commitmentCliff,
    revenue,
    insights,
    periodComparison,
    expenseAnalysis,
  };
}



