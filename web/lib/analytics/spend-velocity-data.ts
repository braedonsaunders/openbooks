import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { analyticsConfig } from "./config";
import { getMoneyFormatter } from '../money-server'

/**
 * Spend Velocity — an implementation of the SpendVelocity dashboard
 * (Lib_SpendVelocity_Data.js, account-centric v3).
 *
 * Source data mirrors the four spend transaction types exactly:
 * vendor_bill / expense_report / check (positive) net of vendor_credit —
 * as journal lines on expense/COGS accounts, grouped account × month
 * (primary) and vendor × month (drill-down). PO vs SO velocity feeds the
 * Commitment Cliff; customer invoices feed revenue normalisation.
 *
 * Velocity engine (verbatim): monthly CAGR with a minimum-base guard;
 * acceleration = recent-half CAGR − early-half CAGR; trends classified by
 * high(15)/medium(5) thresholds. Detectors: statistical anomalies (z≥2.5σ),
 * boiling frog (small monotonic creep), zombie subscriptions (identical
 * recurring vendor totals), category fragmentation (many small txns),
 * concentration risk (HHI), seasonal patterns, commitment cliff.
 * Comprehensive health score = 100 − severity-weighted deductions, verbatim.
 *
 * HONEST GAP: the Shadow IT detector needs a line-level VENDOR on
 * expense-report lines (who the employee actually paid). openbooks expense
 * lines carry only the expense account + free-text description, so that
 * detector is reported as unavailable rather than faked.
 */

// ---- Default config -------------------------------------------------
const CFG = {
  velocityHighThreshold: 15,
  velocityMediumThreshold: 5,
  anomalyStdDevThreshold: 2.5,
  topVendorsCount: 30,
  boilingFrogMonths: 6,
  boilingFrogMinIncrease: 3,
  zombieMinMonths: 6,
  fragmentationMinTxns: 20,
  fragmentationMaxAvgSize: 500,
  minBaseAmount: 100,
};

const SPEND_KINDS = ["vendor_bill", "expense_report", "check", "vendor_credit"] as const;

// ---- shapes -----------------------------------------------------------------

export interface VelocityRow {
  id: string;
  name: string;
  entityType: "account" | "vendor";
  totalSpend: number;
  totalBills: number;
  totalExpenses: number;
  totalOther: number;
  billPct: number;
  expensePct: number;
  transactionCount: number;
  monthCount: number;
  velocity: number;
  acceleration: number;
  trend: "accelerating" | "high" | "rising" | "declining" | "stable" | "new";
  latestSpend: number;
  previousSpend: number;
  avgMonthlySpend: number;
  monthlyAmounts: number[];
  monthLabels: string[];
}

export interface SVAnomaly {
  accountId: string;
  accountName: string;
  month: string;
  amount: number;
  expectedAmount: number;
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
  config: typeof CFG;
  summary: {
    totalSpend: number;
    accountCount: number;
    avgVelocity: number;
    avgAcceleration: number;
    acceleratingCount: number;
    deceleratingCount: number;
    highVelocityCount: number;
    healthScore: number;
    healthGrade: string;
    billsTotal: number;
    expensesTotal: number;
    billsVelocity: number;
    expensesVelocity: number;
    savingsPotential: number;
    totalAlerts: number;
  };
  accountVelocity: VelocityRow[];
  vendorVelocity: VelocityRow[];
  anomalies: { summary: { count: number; spikeCount: number; dropCount: number; criticalCount: number }; items: SVAnomaly[] };
  monthlyTrends: {
    month: string;
    totalAmount: number;
    transactionCount: number;
    billAmount: number;
    expenseAmount: number;
    vendorCount: number;
    priorYearAmount: number;
    yoyChange: number;
    velocity: number;
  }[];
  seasonal: {
    patterns: { month: number; monthName: string; totalSpend: number; deviation: number; isHigh: boolean; isLow: boolean }[];
    insights: { type: string; message: string }[];
  };
  boilingFrog: {
    summary: { count: number; criticalCount: number; totalAnnualizedCreep: number };
    accounts: {
      accountId: string; accountName: string; monotonicRatio: number; avgMonthlyIncrease: number; totalCreep: number;
      startAmount: number; endAmount: number; monthCount: number; annualizedCreep: number; monthlyAmounts: number[];
      severity: "critical" | "warning" | "info";
    }[];
  };
  concentration: {
    summary: { hhi: number; hhiStatus: string; top1Share: number; top5Share: number; top10Share: number; riskAccountCount: number };
    accounts: (VelocityRow & { spendShare: number })[];
  };
  zombies: {
    summary: { count: number; criticalCount: number; totalAnnualCost: number };
    subscriptions: { vendorId: string; vendorName: string; amount: number; monthCount: number; annualCost: number; firstMonth: string; lastMonth: string; severity: "critical" | "warning" }[];
  };
  fragmentation: {
    summary: { fragmentedCategories: number; totalFragmentedSpend: number };
    categories: { accountId: string; accountName: string; totalSpend: number; transactionCount: number; avgTransactionSize: number; txnsPerMonth: number; fragmentationScore: number }[];
  };
  shadowIT: { available: false; reason: string };
  commitmentCliff: {
    summary: { poVelocity: number; soVelocity: number; velocityGap: number; ratio: number; status: "healthy" | "warning" | "critical"; monthsToCliff: number | null; totalPO: number; totalSO: number };
    months: { month: string; poAmount: number; soAmount: number }[];
  };
  revenue: { hasData: boolean; totalRevenue: number; opexRatio: number };
  insights: SVInsight[];
  periodComparison: {
    summary: { currentTotal: number; priorTotal: number; twoBackTotal: number; projectedTotal: number; changePct: number; priorLabel: string; twoBackLabel: string };
    accounts: { accountId: string; accountName: string; currentAmount: number; priorAmount: number; twoBackAmount: number; changePct: number; projectedAmount: number; isNew: boolean; monthlyTrend: number[]; velocity: number; acceleration: number; trend: string }[];
  };
  expenseAnalysis: {
    summary: { expenseReportTotal: number; vendorBillTotal: number; topSpenderCount: number; categoryIncreaseTotal: number };
    topSpenders: { employeeId: string; employeeName: string; totalSpend: number; priorSpend: number; reportCount: number; changePct: number }[];
    categories: { categoryId: string; categoryName: string; currentAmount: number; priorAmount: number; changePct: number }[];
    monthlyTrends: { month: string; expenseAmount: number; billAmount: number }[];
  };
}

// ---- CAGR velocity engine (stable) ---------------------------------

function calculateCAGR(startValue: number, endValue: number, periods: number): number {
  if (periods < 1 || startValue <= 0) return 0;
  if (endValue <= 0) return -100;
  const cagr = (Math.pow(endValue / startValue, 1 / periods) - 1) * 100;
  return Math.max(-100, Math.min(200, cagr));
}

function velocityCAGR(monthlyAmounts: number[], minBase = CFG.minBaseAmount): number {
  if (!monthlyAmounts || monthlyAmounts.length < 2) return 0;
  let start = monthlyAmounts[0]!;
  let periods = monthlyAmounts.length - 1;
  const end = monthlyAmounts[monthlyAmounts.length - 1]!;
  if (start < minBase) {
    for (let i = 0; i < monthlyAmounts.length - 1; i++) {
      if (monthlyAmounts[i]! >= minBase) { start = monthlyAmounts[i]!; periods = monthlyAmounts.length - 1 - i; break; }
    }
    if (start < minBase) return 0;
  }
  return calculateCAGR(start, end, periods);
}

function velocityAndAcceleration(amounts: number[], C: typeof CFG = CFG): { velocity: number; acceleration: number; trend: VelocityRow["trend"] } {
  let velocity = 0, acceleration = 0;
  let trend: VelocityRow["trend"] = "stable";
  if (amounts.length >= 2) {
    velocity = velocityCAGR(amounts);
    if (amounts.length >= 4) {
      const mid = Math.floor(amounts.length / 2);
      acceleration = velocityCAGR(amounts.slice(mid)) - velocityCAGR(amounts.slice(0, mid + 1));
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

type SqlNumber = string | number | null;
interface AccountSpendRow extends Record<string, unknown> {
  account_id: string; account_name: string | null; month: string; month_num: number;
  bill_amount: SqlNumber; expense_amount: SqlNumber; check_amount: SqlNumber; credit_amount: SqlNumber;
  total_amount: SqlNumber; transaction_count: SqlNumber;
}
interface VendorSpendRow extends Record<string, unknown> {
  vendor_id: string; vendor_name: string; month: string; total_amount: SqlNumber; transaction_count: SqlNumber;
}
interface PriorYearRow extends Record<string, unknown> { month_num: string; total_amount: SqlNumber; transaction_count: SqlNumber }
interface CommitmentRow extends Record<string, unknown> { kind: string; month: string; amount: SqlNumber }
interface RevenueRow extends Record<string, unknown> { revenue: SqlNumber }
interface SpenderRow extends Record<string, unknown> {
  employee_id: string; employee_name: string; current_spend: SqlNumber; prior_spend: SqlNumber; report_count: SqlNumber;
}
interface ExpenseCategoryRow extends Record<string, unknown> {
  category_id: string; category_name: string | null; current_amount: SqlNumber; prior_amount: SqlNumber;
}
interface ComparisonRow extends Record<string, unknown> {
  account_id: string; account_name: string | null; current_amount: SqlNumber; prior_amount: SqlNumber; two_back_amount: SqlNumber;
}

// ---- main -------------------------------------------------------------------

export async function spendVelocityData(orgId: string, period: { from: string; to: string; label: string }): Promise<SpendVelocityData> {
  const { money } = await getMoneyFormatter(orgId)
  const { from, to } = period;
  const C = { ...CFG, ...(await analyticsConfig(orgId, "spendVelocity")) };

  // Period windows for comparison (verbatim: same day-length back-to-back).
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const periodDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const priorStart = new Date(start.getTime() - periodDays * 86_400_000);
  const twoBackStart = new Date(priorStart.getTime() - periodDays * 86_400_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const priorFrom = ymd(priorStart);
  const twoBackFrom = ymd(twoBackStart);
  // Prior YEAR window for YoY trends.
  const pyFrom = `${start.getUTCFullYear() - 1}${from.slice(4)}`;
  const pyTo = `${end.getUTCFullYear() - 1}${to.slice(4)}`;

  const spendKindsIn = sql.join(SPEND_KINDS.map((k) => sql`${k}`), sql`, `);
  // The spend base: expense/COGS journal lines sourced from spend documents.
  const spendBase = (f: string, t: string) => sql`
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join documents d on d.id = e.source_document_id and d.org_id = e.org_id
    join accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = ${orgId} and d.voided_at is null
      and d.kind in (${spendKindsIn})
      and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
      -- Filter on the line's own posting date: the entry is still joined for
      -- its source document, but the date no longer has to be reached through
      -- it, so the window is a predicate the line index can serve.
      and l.posting_date >= ${f} and l.posting_date <= ${t}`;

  const [acctRows, vendRows, pyRows, poSoRows, revRows, spenderRows, catRows, cmpRows] = await Promise.all([
    // 1. Monthly account spend split by transaction kind (PRIMARY).
    db.execute<AccountSpendRow>(sql`
      select l.account_id, a.name as account_name, a.number as account_number, a.type as account_type,
        to_char(e.posting_date, 'YYYY-MM') as month,
        extract(month from e.posting_date)::int as month_num,
        sum(l.amount) filter (where d.kind = 'vendor_bill') as bill_amount,
        sum(l.amount) filter (where d.kind = 'expense_report') as expense_amount,
        sum(l.amount) filter (where d.kind = 'check') as check_amount,
        -sum(l.amount) filter (where d.kind = 'vendor_credit') as credit_amount,
        sum(l.amount) as total_amount,
        count(distinct d.id) as transaction_count
      ${spendBase(from, to)}
      group by 1, 2, 3, 4, 5, 6
      having sum(l.amount) > 0
    `),
    // 2. Monthly vendor/party spend (drill-down).
    db.execute<VendorSpendRow>(sql`
      select d.party_id as vendor_id, coalesce(p.display_name, 'Unknown') as vendor_name,
        to_char(e.posting_date, 'YYYY-MM') as month,
        sum(l.amount) as total_amount,
        count(distinct d.id) as transaction_count
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where l.org_id = ${orgId} and d.voided_at is null
        and d.kind in (${spendKindsIn})
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${from} and e.posting_date <= ${to}
        and d.party_id is not null
      group by 1, 2, 3
      having sum(l.amount) > 0
    `),
    // 3. Prior-YEAR monthly totals for YoY.
    db.execute<PriorYearRow>(sql`
      select to_char(e.posting_date, 'MM') as month_num, sum(l.amount) as total_amount, count(distinct d.id) as transaction_count
      ${spendBase(pyFrom, pyTo)}
      group by 1
    `),
    // 4. PO vs SO monthly (commitment cliff).
    db.execute<CommitmentRow>(sql`
      select kind, to_char(document_date, 'YYYY-MM') as month, sum(total) as amount
      from documents
      where org_id = ${orgId} and kind in ('purchase_order', 'sales_order') and voided_at is null
        and document_date >= ${from} and document_date <= ${to}
      group by 1, 2
    `),
    // 5. Revenue (income lines) for OpEx normalisation.
    db.execute<RevenueRow>(sql`
      select coalesce(-sum(l.amount), 0) as revenue
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      where l.org_id = ${orgId} and a.type in ('income', 'income_other')
        and e.posting_date >= ${from} and e.posting_date <= ${to}
    `),
    // (Drill-down detail is fetched per entity on click via /api/analytics/drill.)
    // 7. Top spenders — expense reports by employee, current vs prior window.
    db.execute<SpenderRow>(sql`
      select d.party_id as employee_id, coalesce(p.display_name, 'Unknown') as employee_name,
        sum(d.total) filter (where d.posting_date >= ${from}) as current_spend,
        sum(d.total) filter (where d.posting_date < ${from}) as prior_spend,
        count(*) filter (where d.posting_date >= ${from}) as report_count
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind = 'expense_report' and d.voided_at is null
        and d.posting_date >= ${priorFrom} and d.posting_date <= ${to}
      group by 1, 2
      having sum(d.total) > 0
      order by 3 desc nulls last
      limit 50
    `),
    // 8. Expense categories (accounts on expense reports + bills), current vs prior.
    db.execute<ExpenseCategoryRow>(sql`
      select l.account_id as category_id, a.name as category_name,
        sum(l.amount) filter (where e.posting_date >= ${from}) as current_amount,
        sum(l.amount) filter (where e.posting_date < ${from}) as prior_amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${orgId} and d.voided_at is null
        and d.kind in ('expense_report', 'vendor_bill')
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${priorFrom} and e.posting_date <= ${to}
      group by 1, 2
      order by 3 desc nulls last
      limit 50
    `),
    // 9. Period comparison: current vs prior vs two-back per account.
    db.execute<ComparisonRow>(sql`
      select l.account_id, a.name as account_name,
        sum(l.amount) filter (where e.posting_date >= ${from}) as current_amount,
        sum(l.amount) filter (where e.posting_date >= ${priorFrom} and e.posting_date < ${from}) as prior_amount,
        sum(l.amount) filter (where e.posting_date >= ${twoBackFrom} and e.posting_date < ${priorFrom}) as two_back_amount
      ${spendBase(twoBackFrom, to)}
      group by 1, 2
      having sum(l.amount) > 0
    `),
  ]);

  // ---- account velocity (primary) -------------------------------------------
  interface AcctAgg {
    id: string; name: string; months: { month: string; monthNum: number; amount: number; bill: number; expense: number; other: number; txns: number }[];
    totalSpend: number; totalBills: number; totalExpenses: number; totalOther: number; txns: number;
  }
  const acctMap = new Map<string, AcctAgg>();
  for (const r of acctRows.rows) {
    let a = acctMap.get(r.account_id);
    if (!a) {
      a = { id: r.account_id, name: r.account_name ?? `Account ${r.account_id}`, months: [], totalSpend: 0, totalBills: 0, totalExpenses: 0, totalOther: 0, txns: 0 };
      acctMap.set(r.account_id, a);
    }
    const amount = Number(r.total_amount ?? 0);
    const bill = Number(r.bill_amount ?? 0);
    const expense = Number(r.expense_amount ?? 0);
    const other = Number(r.check_amount ?? 0) - Number(r.credit_amount ?? 0);
    a.months.push({ month: r.month, monthNum: Number(r.month_num), amount, bill, expense, other, txns: Number(r.transaction_count ?? 0) });
    a.totalSpend += amount;
    a.totalBills += bill;
    a.totalExpenses += expense;
    a.totalOther += other;
    a.txns += Number(r.transaction_count ?? 0);
  }

  const accountVelocity: VelocityRow[] = [...acctMap.values()].map((a) => {
    a.months.sort((x, y) => x.month.localeCompare(y.month));
    const amounts = a.months.map((m) => m.amount);
    const { velocity, acceleration, trend } = velocityAndAcceleration(amounts, C);
    return {
      id: a.id,
      name: a.name,
      entityType: "account" as const,
      totalSpend: a.totalSpend,
      totalBills: a.totalBills,
      totalExpenses: a.totalExpenses,
      totalOther: a.totalOther,
      billPct: a.totalSpend > 0 ? Math.round((a.totalBills / a.totalSpend) * 100) : 0,
      expensePct: a.totalSpend > 0 ? Math.round((a.totalExpenses / a.totalSpend) * 100) : 0,
      transactionCount: a.txns,
      monthCount: a.months.length,
      velocity,
      acceleration,
      trend,
      latestSpend: amounts[amounts.length - 1] ?? 0,
      previousSpend: amounts.length > 1 ? amounts[amounts.length - 2]! : 0,
      avgMonthlySpend: a.totalSpend / Math.max(1, a.months.length),
      monthlyAmounts: amounts,
      monthLabels: a.months.map((m) => m.month),
    };
  }).sort((x, y) => y.totalSpend - x.totalSpend);

  // ---- vendor velocity (drill-down) ------------------------------------------
  interface VendAgg { id: string; name: string; months: { month: string; amount: number; txns: number }[]; totalSpend: number; txns: number }
  const vendMap = new Map<string, VendAgg>();
  for (const r of vendRows.rows) {
    let v = vendMap.get(r.vendor_id);
    if (!v) { v = { id: r.vendor_id, name: r.vendor_name, months: [], totalSpend: 0, txns: 0 }; vendMap.set(r.vendor_id, v); }
    const amount = Number(r.total_amount ?? 0);
    v.months.push({ month: r.month, amount, txns: Number(r.transaction_count ?? 0) });
    v.totalSpend += amount;
    v.txns += Number(r.transaction_count ?? 0);
  }
  const allVendors = [...vendMap.values()].map((v) => {
    v.months.sort((x, y) => x.month.localeCompare(y.month));
    const amounts = v.months.map((m) => m.amount);
    const { velocity, acceleration, trend } = velocityAndAcceleration(amounts, C);
    return {
      id: v.id, name: v.name, entityType: "vendor" as const,
      totalSpend: v.totalSpend, totalBills: 0, totalExpenses: 0, totalOther: 0, billPct: 0, expensePct: 0,
      transactionCount: v.txns, monthCount: v.months.length,
      velocity, acceleration, trend,
      latestSpend: amounts[amounts.length - 1] ?? 0,
      previousSpend: amounts.length > 1 ? amounts[amounts.length - 2]! : 0,
      avgMonthlySpend: v.totalSpend / Math.max(1, v.months.length),
      monthlyAmounts: amounts, monthLabels: v.months.map((m) => m.month),
    };
  }).sort((x, y) => y.totalSpend - x.totalSpend);
  const vendorVelocity = allVendors.slice(0, C.topVendorsCount);

  // ---- transaction-type velocity (bills vs expense reports) ------------------
  const typeMonthly = new Map<string, { bill: number; expense: number }>();
  for (const a of acctMap.values()) {
    for (const m of a.months) {
      const t = typeMonthly.get(m.month) ?? { bill: 0, expense: 0 };
      t.bill += m.bill; t.expense += m.expense;
      typeMonthly.set(m.month, t);
    }
  }
  const typeMonths = [...typeMonthly.keys()].sort();
  const billsSeries = typeMonths.map((m) => typeMonthly.get(m)!.bill);
  const expSeries = typeMonths.map((m) => typeMonthly.get(m)!.expense);
  const billsTotal = billsSeries.reduce((s, v) => s + v, 0);
  const expensesTotal = expSeries.reduce((s, v) => s + v, 0);
  const billsVelocity = r1(velocityCAGR(billsSeries));
  const expensesVelocity = r1(velocityCAGR(expSeries));

  // ---- anomalies (z-score, verbatim) -----------------------------------------
  const anomalyItems: SVAnomaly[] = [];
  for (const a of acctMap.values()) {
    if (a.months.length < 3) continue;
    const amounts = a.months.map((m) => m.amount);
    const mean = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    const stdDev = Math.sqrt(amounts.reduce((s, v) => s + (v - mean) ** 2, 0) / amounts.length);
    if (stdDev === 0) continue;
    for (const m of a.months) {
      const z = (m.amount - mean) / stdDev;
      if (Math.abs(z) >= C.anomalyStdDevThreshold) {
        anomalyItems.push({
          accountId: a.id, accountName: a.name, month: m.month, amount: m.amount, expectedAmount: mean,
          deviation: Math.round(((m.amount - mean) / mean) * 100), zScore: r1(z),
          type: z > 0 ? "spike" : "drop", severity: Math.abs(z) >= 3 ? "critical" : "warning",
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
  const pyByMonth = new Map<string, { amount: number; txns: number }>(
    pyRows.rows.map((r) => [r.month_num, { amount: Number(r.total_amount ?? 0), txns: Number(r.transaction_count ?? 0) }]),
  );
  const trendMap = new Map<string, { total: number; txns: number; bill: number; expense: number; vendors: Set<string> }>();
  for (const a of acctMap.values()) {
    for (const m of a.months) {
      let t = trendMap.get(m.month);
      if (!t) { t = { total: 0, txns: 0, bill: 0, expense: 0, vendors: new Set() }; trendMap.set(m.month, t); }
      t.total += m.amount; t.txns += m.txns; t.bill += m.bill; t.expense += m.expense;
    }
  }
  for (const r of vendRows.rows) trendMap.get(r.month)?.vendors.add(r.vendor_id);
  const monthlyTrends = [...trendMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, t], i, arr) => {
    const py = pyByMonth.get(month.slice(5, 7));
    const prev = i > 0 ? arr[i - 1]![1].total : 0;
    return {
      month,
      totalAmount: t.total,
      transactionCount: t.txns,
      billAmount: t.bill,
      expenseAmount: t.expense,
      vendorCount: t.vendors.size,
      priorYearAmount: py?.amount ?? 0,
      yoyChange: py && py.amount > 0 ? Math.round(((t.total - py.amount) / py.amount) * 1000) / 10 : 0,
      velocity: i > 0 && prev > 0 ? Math.round(((t.total - prev) / prev) * 1000) / 10 : 0,
    };
  });

  // ---- seasonal patterns --------------------------------------------------------
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const seasonTotals = new Map<number, number>();
  for (const a of acctMap.values()) for (const m of a.months) seasonTotals.set(m.monthNum, (seasonTotals.get(m.monthNum) ?? 0) + m.amount);
  const seasonVals = [...seasonTotals.values()];
  const seasonAvg = seasonVals.length ? seasonVals.reduce((s, v) => s + v, 0) / seasonVals.length : 0;
  const patterns = Array.from({ length: 12 }, (_, i) => {
    const total = seasonTotals.get(i + 1) ?? 0;
    const deviation = seasonAvg > 0 ? Math.round(((total - seasonAvg) / seasonAvg) * 100) : 0;
    return { month: i + 1, monthName: monthNames[i]!, totalSpend: total, deviation, isHigh: deviation > 15, isLow: deviation < -15 };
  });
  const seasonalInsights: { type: string; message: string }[] = [];
  const highMonths = patterns.filter((p) => p.isHigh);
  const lowMonths = patterns.filter((p) => p.isLow);
  if (highMonths.length) seasonalInsights.push({ type: "high_season", message: `Higher spending typically occurs in ${highMonths.map((m) => m.monthName).join(", ")}` });
  if (lowMonths.length) seasonalInsights.push({ type: "low_season", message: `Lower spending typically occurs in ${lowMonths.map((m) => m.monthName).join(", ")}` });

  // ---- boiling frog ---------------------------------------------------------------
  const frogAccounts: SpendVelocityData["boilingFrog"]["accounts"] = [];
  for (const a of acctMap.values()) {
    if (a.months.length < C.boilingFrogMonths) continue;
    let increases = 0, totalCreep = 0;
    for (let i = 1; i < a.months.length; i++) {
      const prev = a.months[i - 1]!.amount, curr = a.months[i]!.amount;
      if (prev > 0) {
        const pct = ((curr - prev) / prev) * 100;
        if (pct > 0 && pct <= 10) { increases++; totalCreep += pct; }
      }
    }
    const monotonicRatio = (increases / (a.months.length - 1)) * 100;
    if (monotonicRatio >= 50 && totalCreep >= C.boilingFrogMinIncrease) {
      const startAmount = a.months[0]!.amount;
      const endAmount = a.months[a.months.length - 1]!.amount;
      frogAccounts.push({
        accountId: a.id, accountName: a.name,
        monotonicRatio: Math.round(monotonicRatio),
        avgMonthlyIncrease: increases > 0 ? r1(totalCreep / increases) : 0,
        totalCreep: Math.round(totalCreep),
        startAmount, endAmount, monthCount: a.months.length,
        annualizedCreep: Math.round(((endAmount - startAmount) * 12) / a.months.length),
        monthlyAmounts: a.months.map((m) => m.amount),
        severity: totalCreep > 20 ? "critical" : totalCreep > 10 ? "warning" : "info",
      });
    }
  }
  frogAccounts.sort((x, y) => y.totalCreep - x.totalCreep);
  const boilingFrog = {
    summary: {
      count: frogAccounts.length,
      criticalCount: frogAccounts.filter((x) => x.severity === "critical").length,
      totalAnnualizedCreep: frogAccounts.reduce((s, x) => s + ((x.endAmount - x.startAmount) * 12) / x.monthCount, 0),
    },
    accounts: frogAccounts.slice(0, 20),
  };

  // ---- concentration risk (HHI) ----------------------------------------------------
  const totalSpend = accountVelocity.reduce((s, a) => s + a.totalSpend, 0);
  const withShares = accountVelocity.map((a) => ({ ...a, spendShare: totalSpend > 0 ? (a.totalSpend / totalSpend) * 100 : 0 }));
  const hhi = withShares.reduce((s, a) => s + a.spendShare ** 2, 0);
  const concentration = {
    summary: {
      hhi: Math.round(hhi),
      hhiStatus: hhi > 2500 ? "concentrated" : hhi > 1500 ? "moderate" : "diversified",
      top1Share: r1(withShares[0]?.spendShare ?? 0),
      top5Share: r1(withShares.slice(0, 5).reduce((s, a) => s + a.spendShare, 0)),
      top10Share: r1(withShares.slice(0, 10).reduce((s, a) => s + a.spendShare, 0)),
      riskAccountCount: withShares.filter((a) => a.spendShare > 5 && (a.trend === "accelerating" || a.trend === "high")).length,
    },
    accounts: withShares.filter((a) => a.spendShare > 5 && (a.trend === "accelerating" || a.trend === "high")).slice(0, 10),
  };

  // ---- zombie subscriptions -----------------------------------------------------------
  const zombieList: SpendVelocityData["zombies"]["subscriptions"] = [];
  for (const v of vendMap.values()) {
    if (v.months.length < C.zombieMinMonths) continue;
    const amounts = v.months.map((m) => Math.round(m.amount * 100) / 100);
    const first = amounts[0]!;
    let isZombie = amounts.every((x) => x === first);
    if (!isZombie) {
      const mean = amounts.reduce((s, x) => s + x, 0) / amounts.length;
      const maxDev = Math.max(...amounts.map((x) => Math.abs(x - mean)));
      isZombie = mean > 0 && (maxDev / mean) * 100 < 1;
    }
    if (isZombie && first > 0) {
      zombieList.push({
        vendorId: v.id, vendorName: v.name, amount: first, monthCount: v.months.length,
        annualCost: first * 12, firstMonth: v.months[0]!.month, lastMonth: v.months[v.months.length - 1]!.month,
        severity: v.months.length >= 12 ? "critical" : "warning",
      });
    }
  }
  zombieList.sort((x, y) => y.annualCost - x.annualCost);
  const zombies = {
    summary: {
      count: zombieList.length,
      criticalCount: zombieList.filter((z) => z.severity === "critical").length,
      totalAnnualCost: zombieList.reduce((s, z) => s + z.annualCost, 0),
    },
    subscriptions: zombieList.slice(0, 20),
  };

  // ---- category fragmentation -----------------------------------------------------------
  const fragList: SpendVelocityData["fragmentation"]["categories"] = [];
  for (const a of acctMap.values()) {
    const avgTxnSize = a.txns > 0 ? a.totalSpend / a.txns : 0;
    const txnsPerMonth = a.months.length > 0 ? a.txns / a.months.length : 0;
    if (txnsPerMonth > C.fragmentationMinTxns && avgTxnSize < C.fragmentationMaxAvgSize) {
      fragList.push({
        accountId: a.id, accountName: a.name, totalSpend: a.totalSpend, transactionCount: a.txns,
        avgTransactionSize: avgTxnSize, txnsPerMonth: Math.round(txnsPerMonth),
        fragmentationScore: avgTxnSize > 0 ? Math.round((txnsPerMonth / avgTxnSize) * 100) : 0,
      });
    }
  }
  fragList.sort((x, y) => y.fragmentationScore - x.fragmentationScore);
  const fragmentation = {
    summary: { fragmentedCategories: fragList.length, totalFragmentedSpend: Math.round(fragList.reduce((s, f) => s + f.totalSpend, 0)) },
    categories: fragList.slice(0, 15),
  };

  // ---- shadow IT — honest gap -------------------------------------------------------------
  const shadowIT = {
    available: false as const,
    reason: "Expense-report lines carry no line-level merchant/vendor — only the expense account and a free-text description — so viral software adoption across employees cannot be traced.",
  };

  // ---- commitment cliff ----------------------------------------------------------------------
  const cliffMonths = new Map<string, { po: number; so: number }>();
  for (const r of poSoRows.rows) {
    const m = cliffMonths.get(r.month) ?? { po: 0, so: 0 };
    if (r.kind === "purchase_order") m.po += Number(r.amount ?? 0);
    else m.so += Number(r.amount ?? 0);
    cliffMonths.set(r.month, m);
  }
  const cliffSeries = [...cliffMonths.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, poAmount: v.po, soAmount: v.so }));
  let commitmentCliff: SpendVelocityData["commitmentCliff"];
  if (cliffSeries.length < 2) {
    commitmentCliff = { summary: { poVelocity: 0, soVelocity: 0, velocityGap: 0, ratio: 0, status: "healthy", monthsToCliff: null, totalPO: 0, totalSO: 0 }, months: cliffSeries };
  } else {
    const poVelocity = Math.round(velocityCAGR(cliffSeries.map((m) => m.poAmount), 1000));
    const soVelocity = Math.round(velocityCAGR(cliffSeries.map((m) => m.soAmount), 1000));
    const velocityGap = poVelocity - soVelocity;
    const totalPO = cliffSeries.reduce((s, m) => s + m.poAmount, 0);
    const totalSO = cliffSeries.reduce((s, m) => s + m.soAmount, 0);
    const ratio = totalSO > 0 ? Math.round((totalPO / totalSO) * 100) / 100 : 0;
    let status: "healthy" | "warning" | "critical" = "healthy";
    let monthsToCliff: number | null = null;
    if (velocityGap > 20 || ratio > 1.5) {
      status = "critical";
      if (velocityGap > 0 && totalSO > 0) monthsToCliff = Math.max(1, Math.round(12 / (velocityGap / 10)));
    } else if (velocityGap > 10 || ratio > 1.2) {
      status = "warning";
      if (velocityGap > 0 && totalSO > 0) monthsToCliff = Math.max(1, Math.round(18 / (velocityGap / 10)));
    }
    commitmentCliff = { summary: { poVelocity, soVelocity, velocityGap, ratio, status, monthsToCliff, totalPO: Math.round(totalPO), totalSO: Math.round(totalSO) }, months: cliffSeries };
  }

  // ---- revenue normalisation ---------------------------------------------------------------------
  const totalRevenue = Number(revRows.rows[0]?.revenue ?? 0);
  const revenue = { hasData: totalRevenue > 0, totalRevenue, opexRatio: totalRevenue > 0 ? Math.round((totalSpend / totalRevenue) * 100) : 0 };

  // ---- period comparison ------------------------------------------------------------------------------
  const cmpAccounts = cmpRows.rows.map((r) => {
    const current = Number(r.current_amount ?? 0);
    const prior = Number(r.prior_amount ?? 0);
    const twoBack = Number(r.two_back_amount ?? 0);
    const changePct = prior > 0 ? ((current - prior) / prior) * 100 : current > 0 ? 100 : 0;
    let avgChange = 0;
    if (prior > 0 && twoBack > 0) avgChange = (current / prior + prior / twoBack) / 2 - 1;
    else if (prior > 0) avgChange = current / prior - 1;
    const vel = accountVelocity.find((a) => a.id === r.account_id);
    return {
      accountId: r.account_id,
      accountName: r.account_name ?? `Account ${r.account_id}`,
      currentAmount: current,
      priorAmount: prior,
      twoBackAmount: twoBack,
      changePct: r1(changePct),
      projectedAmount: Math.round(current * (1 + Math.min(Math.max(avgChange, -0.5), 0.5))),
      isNew: prior === 0 && current > 0,
      monthlyTrend: vel?.monthlyAmounts ?? [],
      velocity: vel?.velocity ?? 0,
      acceleration: vel?.acceleration ?? 0,
      trend: vel?.trend ?? "stable",
    };
  }).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const currentTotal = cmpAccounts.reduce((s, a) => s + a.currentAmount, 0);
  const priorTotal = cmpAccounts.reduce((s, a) => s + a.priorAmount, 0);
  const twoBackTotal = cmpAccounts.reduce((s, a) => s + a.twoBackAmount, 0);
  const overallChange = priorTotal > 0 ? ((currentTotal - priorTotal) / priorTotal) * 100 : 0;
  const periodComparison = {
    summary: {
      currentTotal: Math.round(currentTotal),
      priorTotal: Math.round(priorTotal),
      twoBackTotal: Math.round(twoBackTotal),
      projectedTotal: Math.round(currentTotal * (1 + Math.min(Math.max(overallChange / 100, -0.3), 0.3))),
      changePct: r1(overallChange),
      priorLabel: `${priorFrom} → ${ymd(new Date(start.getTime() - 86_400_000))}`,
      twoBackLabel: `${twoBackFrom} → ${ymd(new Date(priorStart.getTime() - 86_400_000))}`,
    },
    accounts: cmpAccounts,
  };

  // ---- expense analysis ---------------------------------------------------------------------------------------
  const topSpenders = spenderRows.rows.map((r) => {
    const current = Number(r.current_spend ?? 0);
    const prior = Number(r.prior_spend ?? 0);
    return {
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      totalSpend: current,
      priorSpend: prior,
      reportCount: Number(r.report_count ?? 0),
      changePct: prior > 0 ? r1(((current - prior) / prior) * 100) : 0,
    };
  }).filter((s) => s.totalSpend > 0 || s.priorSpend > 0);
  let categoryIncreaseTotal = 0;
  const expCategories = catRows.rows.map((r) => {
    const current = Number(r.current_amount ?? 0);
    const prior = Number(r.prior_amount ?? 0);
    const changePct = prior > 0 ? r1(((current - prior) / prior) * 100) : 0;
    if (changePct > 10) categoryIncreaseTotal += current - prior;
    return { categoryId: r.category_id, categoryName: r.category_name ?? "", currentAmount: current, priorAmount: prior, changePct };
  }).filter((c) => c.currentAmount > 0 || c.priorAmount > 0);
  const expenseAnalysis = {
    summary: {
      expenseReportTotal: Math.round(topSpenders.reduce((s, x) => s + x.totalSpend, 0)),
      vendorBillTotal: Math.round(billsTotal),
      topSpenderCount: topSpenders.filter((s) => s.changePct > 20).length,
      categoryIncreaseTotal: Math.round(categoryIncreaseTotal),
    },
    topSpenders,
    categories: expCategories,
    monthlyTrends: typeMonths.map((m) => ({ month: m, expenseAmount: typeMonthly.get(m)!.expense, billAmount: typeMonthly.get(m)!.bill })),
  };

  // ---- summary + comprehensive health score (verbatim weights) ---------------------------------------------------
  const avgVelocity = accountVelocity.length ? accountVelocity.reduce((s, a) => s + a.velocity, 0) / accountVelocity.length : 0;
  const avgAcceleration = accountVelocity.length ? accountVelocity.reduce((s, a) => s + a.acceleration, 0) / accountVelocity.length : 0;
  const acceleratingCount = accountVelocity.filter((a) => a.trend === "accelerating").length;
  const highVelocityCount = accountVelocity.filter((a) => a.velocity > 15).length;

  let deductions = 0;
  // Velocity health (max −20).
  deductions += Math.min(20, Math.min(10, highVelocityCount * 1.5) + Math.min(10, acceleratingCount * 1.5));
  // Critical issues (max −25).
  const criticalFrog = boilingFrog.summary.criticalCount;
  const criticalZombies = zombies.summary.criticalCount;
  deductions += Math.min(25, Math.min(12, anomalies.summary.criticalCount * 4) + Math.min(8, criticalFrog * 3) + Math.min(5, criticalZombies * 2));
  // Warnings (max −15).
  deductions += Math.min(15,
    Math.min(6, (anomalies.summary.count - anomalies.summary.criticalCount) * 1.5) +
    Math.min(4, (boilingFrog.summary.count - criticalFrog) * 1) +
    Math.min(3, (zombies.summary.count - criticalZombies) * 1));
  // Structural risk (max −15).
  let structural = 0;
  const top1 = concentration.summary.top1Share;
  if (top1 > 30) structural += 5; else if (top1 > 25) structural += 3; else if (top1 > 20) structural += 1;
  structural += Math.min(4, fragmentation.summary.fragmentedCategories * 0.5);
  if (commitmentCliff.summary.status === "critical") structural += 6;
  else if (commitmentCliff.summary.status === "warning") structural += 3;
  deductions += Math.min(15, structural);
  // Financial impact (max −10).
  const savingsPotential = boilingFrog.summary.totalAnnualizedCreep + zombies.summary.totalAnnualCost;
  const savingsWithFrag = savingsPotential + fragmentation.summary.totalFragmentedSpend * 0; // frag excluded as designed
  void savingsWithFrag;
  if (totalSpend > 0) {
    const ratio = (boilingFrog.summary.totalAnnualizedCreep + fragmentation.summary.totalFragmentedSpend * 0 + zombies.summary.totalAnnualCost) / totalSpend;
    if (ratio > 0.05) deductions += 10;
    else if (ratio > 0.03) deductions += 7;
    else if (ratio > 0.02) deductions += 5;
    else if (ratio > 0.01) deductions += 3;
    else if (ratio > 0.005) deductions += 1;
  }
  const healthScore = Math.round(Math.max(0, Math.min(100, 100 - deductions)));
  const healthGrade = healthScore >= 90 ? "A" : healthScore >= 80 ? "B" : healthScore >= 70 ? "C" : healthScore >= 60 ? "D" : "F";

  const totalAlerts = boilingFrog.summary.count + anomalies.summary.count + zombies.summary.count + fragmentation.summary.fragmentedCategories;

  // ---- insights (verbatim conditions) ---------------------------------------------------------------------------------
  const insights: SVInsight[] = [];
  const fmtK = (n: number) => money(n, { maximumFractionDigits: 0 });
  const highVel20 = accountVelocity.filter((a) => a.velocity > 20);
  if (highVel20.length) insights.push({ type: "alert", title: "High Growth Expense Categories", message: `${highVel20.length} expense account(s) growing >20%/month`, action: "Review spending policies for these categories" });
  if (Math.abs(billsVelocity - expensesVelocity) > 20) {
    const faster = billsVelocity > expensesVelocity ? "Bills" : "Expense Reports";
    insights.push({ type: "warning", title: "Transaction Type Imbalance", message: `${faster} growing ${Math.abs(Math.round(billsVelocity - expensesVelocity))}% faster than other type`, action: "Review approval workflows and spending controls" });
  }
  if (anomalies.summary.criticalCount > 0) insights.push({ type: "alert", title: "Spending Anomalies Detected", message: `${anomalies.summary.criticalCount} critical anomalies require investigation`, action: "Review flagged transactions for errors or unauthorized spend" });
  if (boilingFrog.summary.criticalCount > 0) insights.push({ type: "warning", title: "Gradual Cost Creep Detected", message: `${boilingFrog.summary.criticalCount} account(s) showing consistent increases`, action: "Negotiate rates or find alternative solutions" });
  if (concentration.summary.top1Share > 25) insights.push({ type: "warning", title: "High Spend Concentration", message: `Top expense category accounts for ${Math.round(concentration.summary.top1Share)}% of spend`, action: "Review for cost optimization opportunities" });
  if (zombies.summary.count > 0) insights.push({ type: "info", title: "Potential Unused Subscriptions", message: `${zombies.summary.count} vendor(s) with identical recurring charges (${fmtK(zombies.summary.totalAnnualCost)}/year)`, action: "Review for usage — these may be auto-renewing unused services" });
  if (fragmentation.summary.fragmentedCategories > 0) insights.push({ type: "warning", title: "Purchasing Fragmentation Detected", message: `${fragmentation.summary.fragmentedCategories} category(ies) with high transaction volume and low avg size`, action: "Consider vendor consolidation or preferred supplier agreements" });
  if (revenue.hasData && revenue.opexRatio > 50) insights.push({ type: "alert", title: "High OpEx to Revenue Ratio", message: `Operating expenses are ${revenue.opexRatio}% of revenue`, action: "Review cost structure and identify efficiency opportunities" });
  if (commitmentCliff.summary.status !== "healthy") {
    const c = commitmentCliff.summary;
    insights.push({
      type: c.status === "critical" ? "alert" : "warning",
      title: "Purchase-Sales Velocity Imbalance",
      message: `PO velocity (${c.poVelocity}%/mo) exceeds SO velocity (${c.soVelocity}%/mo) by ${c.velocityGap}% — PO/SO ratio: ${c.ratio}×`,
      action: c.monthsToCliff ? `Cash pressure risk in ~${c.monthsToCliff} months. Review purchase commitments.` : "Monitor purchase velocity and align with sales pipeline.",
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
