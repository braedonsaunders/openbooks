import "server-only";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { evaluateFormula } from "./formula";
import { getMoneyFormatter } from '../money-server'
import { resolveOrgId } from '../org-scope'

export { openItems } from './open-items'

/**
 * Shared cash-engine core — the primitives behind BOTH the read-only analytics
 * cashflow forecast (analytics/cashflow) and the operational domain cockpits
 * (AP / AR / Banking-Cash). It was extracted from the original
 * analytics `cashflow-data.ts` so the numbers stay byte-identical.
 *
 * Rule of the house: one source of truth. Analytics *explains* the forecast,
 * cockpits *act* on it — but both read the same predicted dates, aging buckets
 * and payment statistics computed here.
 *
 * All dates are handled as UTC-midnight to match the ledger's date columns.
 */

export const MS_DAY = 86_400_000;
export const parseISO = (s: string) => new Date(s + "T00:00:00Z");
export const toISO = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_DAY);
export const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MS_DAY);
/** Sunday of the week (date − getDay()). */
export const weekStart = (d: Date) => addDays(d, -d.getUTCDay());
/** Weekend → next business day (Sat +2, Sun +1). */
export const businessDay = (d: Date) => {
  const day = d.getUTCDay();
  if (day === 6) return addDays(d, 2);
  if (day === 0) return addDays(d, 1);
  return d;
};
export const weekLabel = (d: Date) => {
  const m = d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return m;
};

export type Side = "ar" | "ap";

export interface Bucket {
  label: string;
  amount: number;
}
export interface ForecastEntry {
  id: string;
  entryId: string;
  docKind: string | null;
  docNumber: string | null;
  docId: string | null;
  partyId: string | null;
  partyName: string;
  amount: number;
  tranDate: string;
  dueDate: string | null;
  predictedDate: string;
  weekStart: string;
  daysOverdue: number;
  method: string;
}
export interface WeekRow {
  weekStart: string;
  weekEnd: string;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  startingCash: number;
  endingCash: number;
  /**
   * The week's transactions. Omitted from a page's initial payload — a cockpit
   * ships thousands of these per week and renders them only when a week is
   * opened, so `weekForecastEntries` fetches the clicked week on demand.
   * Consumers that only need magnitudes must read the totals/counts below,
   * which are always populated.
   */
  arEntries: ForecastEntry[];
  apEntries: ForecastEntry[];
  /** Always present, even when the entry arrays have been withheld. */
  arTotal: number;
  apTotal: number;
  arCount: number;
  apCount: number;
  /** Non-AR/AP forecast flows from configured categories. */
  dynamicInflow: number;
  dynamicOutflow: number;
  /** AP scheduled but pushed to a later week by the capacity scheduler. */
  deferredOut: number;
  /** Available AP capacity this week (null = unlimited, no scheduling). */
  apCapacity: number | null;
}

/**
 * Non-AR/AP forecast category. All seven
 * calculation strategies are supported: GL History Average, Vendor Payment
 * History, Credit Card Cycle, Manual Recurring, Formula Expression, Vendor
 * Recurring (Auto) and Bank Register History — plus the expected-day /
 * expected-week placement (getProrationFactor).
 */
export type ForecastCategoryMethod =
  | "gl_history_average"
  | "vendor_payment_history"
  | "credit_card_cycle"
  | "manual_recurring"
  | "formula_expression"
  | "vendor_recurring_average"
  | "bank_register_history";

export interface ForecastCategory {
  id: string;
  name: string;
  direction: "inflow" | "outflow";
  method: ForecastCategoryMethod;
  /** Day-of-week (0=Sun…6=Sat) the flow lands on — '' / undefined = spread. */
  expectedDay?: number | string | null;
  /** Week-of-month (1–4) the flow lands in — '' / undefined = every week. */
  expectedWeek?: number | string | null;
  /** History window (weeks) — gl_history_average, bank_register_history. */
  historyWeeks?: number;
  /** History window (months) — vendor histories, credit_card_cycle. */
  historyMonths?: number;
  adjustmentPct?: number; // default 0
  // gl_history_average
  accountIds?: string[];
  /** Sum signed amounts (netting refunds) instead of gross per-line activity. */
  useNetAmt?: boolean;
  // vendor_payment_history / vendor_recurring_average
  partyId?: string;
  partyName?: string;
  partyIds?: string[];
  // credit_card_cycle
  cardAccountIds?: string[];
  significantPaymentThreshold?: number;
  // manual_recurring
  amount?: number;
  frequency?: "weekly" | "biweekly" | "bi_weekly" | "monthly";
  // formula_expression
  formula?: string;
  // bank_register_history
  bankAccountIds?: string[];
  memoKeywords?: string[];
  includeTransfers?: boolean;
  includeChecks?: boolean;
  includeJournals?: boolean;
}

/**
 * Context handed to the category engine: the AR/AP forecast totals per week
 * key and starting cash — the variables the formula strategy exposes
 * ({AR_IN}, {AP_OUT}, {NET_FLOW}, {CASH_START}).
 */
export interface CategoryContext {
  arWeekly: Record<string, number>;
  apWeekly: Record<string, number>;
  cashStart: number;
  /** Active subsidiary view — SQL-backed strategies scope their history to it
   * (manual/formula strategies are org-level models and ignore it). */
  subIds?: string[];
}

/** A source item behind a category estimate (the breakdown rows). */
export interface CategoryBreakdownRow {
  name: string;
  date?: string;
  amount: number;
  type: string;
  /** Extra context (payment counts, projection method, memo…). */
  details?: string;
}

export interface CategoryWeekly {
  id: string;
  name: string;
  direction: "inflow" | "outflow";
  method: ForecastCategory["method"];
  weekly: number[]; // aligned with weeks[]
  total: number;
  /** Human explanation of the computation (the Forecast Logic card). */
  logic: string;
  /** Display method label and the numbers behind the estimate. */
  meta: { method: string } & Record<string, string | number>;
  /** The source items the estimate was derived from. */
  breakdown: CategoryBreakdownRow[];
}

export interface SideSummary {
  outstanding: number;
  scheduled: number; // amount predicted within the horizon
  pctCurrent: number;
  avgDays: number;
  buckets: Bucket[];
}

export interface OpenItem {
  id: string;
  entryId: string;
  docKind: string | null;
  docNumber: string | null;
  docId: string | null;
  partyId: string | null;
  partyName: string;
  tranDate: Date;
  dueDate: Date | null;
  remaining: number;
}

export type PaymentStats = { map: Map<string, { avg: number; sd: number }>; globalAvg: number };

/**
 * The same weeks with their per-transaction arrays withheld. Totals and counts
 * survive, so every summary still renders from the initial payload; the detail
 * is fetched per week when the reader opens one. Nothing is lost — only
 * deferred.
 */
export function withoutWeekEntries(weeks: WeekRow[]): WeekRow[] {
  return weeks.map((w) => ({ ...w, arEntries: [], apEntries: [] }));
}

/** A resolved week grid for a horizon anchored at `asOf`. */
export interface WeekGrid {
  asOfIso: string;
  asOf: Date;
  start: Date;
  end: Date;
  weekStarts: string[];
}

/** Build the Sunday-aligned week grid for a horizon (). */
export function buildWeekGrid(asOfIso: string, horizonWeeks: number): WeekGrid {
  const asOf = parseISO(asOfIso);
  const start = weekStart(asOf);
  const end = addDays(start, horizonWeeks * 7 - 1);
  const weekStarts: string[] = [];
  for (let cur = new Date(start); cur <= end; cur = addDays(cur, 7)) weekStarts.push(toISO(cur));
  return { asOfIso, asOf, start, end, weekStarts };
}

/** Clamp an as-of date to the organization's business day (never forecast from the future). */
export async function resolveAsOf(orgId: string, asOfDate?: string): Promise<string> {
  const today = await businessToday(orgId);
  return asOfDate && asOfDate < today ? asOfDate : today;
}

/**
 * Optional subsidiary scope — ` and <col> = any(ids)` when a subsidiary view
 * is active (the statement-matrix filter pattern), empty otherwise so
 * single-subsidiary orgs and unscoped callers run byte-identical SQL.
 */
function subScope(col: ReturnType<typeof sql>, subIds?: string[]) {
  return subIds && subIds.length > 0 ? sql` and ${col} = any(${`{${subIds.join(",")}}`}::uuid[])` : sql``;
}

/**
 * Per-party avg days (+ σ) from invoice/bill date to the applied payment.
 * Forecast policy: history restricted to the trailing 365 days (paymentHistoryDays),
 * global average weighted by data point (globalSum/globalCount over all payments,
 * not an average of per-party averages), and 45-day default when no history exists.
 */
export async function paymentStats(side: Side, asOfIso: string): Promise<PaymentStats> {
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  // Settlement behaviour comes from party_payment_stats, the rollup maintained
  // at the settlement event (see 0001_baseline.sql). It stores sufficient
  // statistics per (party, settlement day) — count, Σdays, Σdays² — so the
  // trailing window is an exact range scan and both the mean and the
  // population standard deviation are reconstructed here without touching the
  // ledger. Deriving them from applications meant four joins over every
  // settlement in the tenant on every cockpit render.
  const orgId = await resolveOrgId();
  const r = (await db.execute(sql`
    select party_id as id,
           sum(sum_days) / sum(n) as avg_days,
           sqrt(greatest(
             sum(sum_days_sq) / sum(n) - (sum(sum_days) / sum(n)) * (sum(sum_days) / sum(n)),
             0)) as sd_days,
           sum(n) as n
      from party_payment_stats
     where org_id = ${orgId} and account_type = ${acctType}
       and settled_on >= ${asOfIso}::date - 365
       and settled_on <= ${asOfIso}::date
     group by party_id
    having sum(n) > 0
  `));
  const map = new Map<string, { avg: number; sd: number }>();
  let sum = 0;
  let count = 0;
  for (const x of r.rows as any[]) {
    const avg = Number(x.avg_days);
    const n = Number(x.n);
    map.set(x.id, { avg, sd: Number(x.sd_days) });
    sum += avg * n;
    count += n;
  }
  return { map, globalAvg: count > 0 ? Math.round(sum / count) : 45 };
}

/** Load configured categories from orgs.settings.analytics.cashflowCategories. */
export async function loadCategories(orgId: string): Promise<ForecastCategory[]> {
  const r = (await db.execute(sql`
    select settings -> 'analytics' -> 'cashflowCategories' as cats from orgs where id = ${orgId}
  `));
  const raw = r.rows[0]?.cats;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) => c && typeof c === "object" && c.id && c.name && c.method);
}

/* ------------------- category engine helpers ------------------------------- */

const addMonthsUTC = (d: Date, n: number): Date => {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCMonth(r.getUTCMonth() + n);
  if (r.getUTCDate() < day) r.setUTCDate(0);
  return r;
};
const daysInMonthUTC = (d: Date): number => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
const round2 = (n: number): number => Math.round(n * 100) / 100;
const isSet = (v: number | string | null | undefined): boolean => v !== null && v !== undefined && v !== "";

/**
 *  — places a weekly amount on its expected day of
 * week / week of month, zeroes weeks whose slot has already passed, and
 * prorates the current distributed week by business days remaining.
 */
export function getProrationFactor(
  weekStartDate: Date,
  asOf: Date,
  expectedDay?: number | string | null,
  expectedWeek?: number | string | null,
): number {
  const wStart = weekStartDate;
  let targetDate = new Date(wStart);
  let isSpecificDay = false;

  if (isSet(expectedDay)) {
    isSpecificDay = true;
    const distance = Number(expectedDay) - wStart.getUTCDay();
    targetDate = addDays(wStart, distance);
  }

  if (isSet(expectedWeek)) {
    const dayOfMonth = targetDate.getUTCDate();
    const targetWk = Number(expectedWeek);
    const actualWk = Math.ceil(dayOfMonth / 7);
    const isMatch = (targetWk === 4 && dayOfMonth >= 22) || targetWk === actualWk;
    if (!isMatch) return 0;
  }

  if (isSpecificDay) return targetDate < asOf ? 0 : 1;
  if (isSet(expectedWeek)) return addDays(wStart, 6) < asOf ? 0 : 1;
  if (wStart > asOf) return 1;

  const weekEnd = addDays(wStart, 6);
  let loopDate = new Date(asOf);
  if (loopDate > weekEnd) return 0;
  if (loopDate < wStart) loopDate = new Date(wStart);
  let businessDaysRemaining = 0;
  while (loopDate <= weekEnd) {
    const day = loopDate.getUTCDay();
    if (day >= 1 && day <= 5) businessDaysRemaining++;
    loopDate = addDays(loopDate, 1);
  }
  return Math.min(Math.max(businessDaysRemaining / 5, 0), 1);
}

/**
 * Compute one category's weekly amounts across the horizon — ALL SEVEN of
 * the strategies (Lib_Cashflow_Data processCategory), ported faithfully:
 *
 *  - gl_history_average: weekly GL activity average over historyWeeks, actuals
 *    override forecast inside the horizon, optional net-amount mode.
 *  - vendor_payment_history: median non-zero monthly outflow to the vendors ÷
 *    4.345 (or placed monthly when an expected week is set).
 *  - credit_card_cycle: statement-cycle model — detected payment day, median
 *    completed-month payment, current balance + burn-rate trajectory blend.
 *  - manual_recurring: fixed amount stepped weekly / bi-weekly / monthly.
 *  - formula_expression: Excel-style formula over {AR_IN}/{AP_OUT}/{NET_FLOW}/
 *    {CASH_START}/{WEEK_NUM}/calendar flags, evaluated safely per week.
 *  - vendor_recurring_average: auto-detected payment cadence (median interval,
 *    2σ outlier filter) scheduled forward from the last payment.
 *  - bank_register_history: average of actual bank cash-out by week, filtered
 *    by document kind and memo keywords, current-week actuals netted off.
 *
 * Expected-day / expected-week placement applies via getProrationFactor.
 */
export async function categoryWeekly(
  orgId: string,
  cat: ForecastCategory,
  asOfIso: string,
  weekStarts: string[],
  context: CategoryContext,
): Promise<CategoryWeekly> {
  const { money } = await getMoneyFormatter(orgId)
  const n = weekStarts.length;
  const weekly = new Array<number>(n).fill(0);
  const asOf = parseISO(asOfIso);
  const tStart = parseISO(weekStarts[0]!);
  const tEnd = addDays(parseISO(weekStarts[n - 1]!), 6);
  const adj = (cat.adjustmentPct ?? 0) / 100;
  let logic = "";
  let meta: CategoryWeekly["meta"] = { method: "Unknown" };
  let breakdown: CategoryBreakdownRow[] = [];
  const wkIndex = new Map(weekStarts.map((w, i) => [w, i]));
  const put = (wk: string, amount: number) => {
    const i = wkIndex.get(wk);
    if (i !== undefined) weekly[i] = (weekly[i] ?? 0) + amount;
  };

  if (cat.method === "manual_recurring") {
    const amount = Math.abs(cat.amount ?? 0);
    const freqRaw = cat.frequency ?? "monthly";
    const freq = freqRaw === "bi_weekly" ? "biweekly" : freqRaw;
    let curr = new Date(tStart);
    while (curr <= tEnd) {
      const wk = toISO(weekStart(curr));
      let currentAmount = amount;
      if (freq === "weekly") currentAmount *= getProrationFactor(curr, asOf, null, null);
      put(wk, currentAmount);
      if (freq === "monthly") curr = addMonthsUTC(curr, 1);
      else if (freq === "biweekly") curr = addDays(curr, 14);
      else curr = addDays(curr, 7);
    }
    logic = `${money(amount, { maximumFractionDigits: 0 })} ${freq}`;
    meta = { method: "Manual Recurring", amount: Math.round(amount), frequency: freq };
    breakdown = weekStarts
      .map((w, i) => ({ name: `Manual (${freq})`, date: w, amount: round2(weekly[i] ?? 0), type: "Scheduled" }))
      .filter((row) => row.amount > 0);
  } else if (cat.method === "gl_history_average" && cat.accountIds?.length) {
    const historyWeeks = Math.max(1, Math.min(52, cat.historyWeeks ?? 12));
    const useNet = cat.useNetAmt === true;
    const ids = sql.join(cat.accountIds.map((a) => sql`${a}`), sql`, `);
    const historyStart = addDays(tStart, -historyWeeks * 7);
    // Grouped by Sunday-start week AND account: weeks before the horizon feed
    // the average, weeks inside it act as actuals ().
    const r = (await db.execute(sql`
      select (e.posting_date - extract(dow from e.posting_date)::int)::text as wk,
             a.number, a.name,
             sum(l.amount) as net, sum(abs(l.amount)) as gross
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${orgId} and l.account_id in (${ids})
        and e.posting_date >= ${toISO(historyStart)} and e.posting_date <= ${toISO(tEnd)}${subScope(sql`l.subsidiary_id`, context.subIds)}
      group by 1, a.number, a.name
    `));
    const weeklyHistory: Record<string, number> = {};
    const accountTotals = new Map<string, number>();
    for (const x of r.rows as any[]) {
      const v = useNet ? Number(x.net) : Math.abs(Number(x.net));
      weeklyHistory[x.wk] = (weeklyHistory[x.wk] ?? 0) + v;
      const label = [x.number, x.name].filter(Boolean).join(" · ");
      accountTotals.set(label, (accountTotals.get(label) ?? 0) + Math.abs(Number(x.net)));
    }
    let totalHistory = 0;
    let weeksCounted = 0;
    const startKey = toISO(tStart);
    for (const k of Object.keys(weeklyHistory)) {
      if (k < startKey) { totalHistory += weeklyHistory[k]!; weeksCounted++; }
    }
    const divisor = weeksCounted > 0 ? weeksCounted : historyWeeks;
    let weeklyAvg = (useNet ? totalHistory : Math.abs(totalHistory)) / divisor;
    if (adj !== 0) weeklyAvg = weeklyAvg * (1 + adj);
    const forecastAmount = isSet(cat.expectedWeek) ? weeklyAvg * 4.345 : weeklyAvg;
    weekStarts.forEach((k, i) => {
      const actual = weeklyHistory[k] ?? 0;
      let amount = actual > 0 ? actual : forecastAmount;
      amount *= getProrationFactor(parseISO(k), asOf, cat.expectedDay, cat.expectedWeek);
      weekly[i] = round2(amount);
    });
    logic = `${historyWeeks}-week GL average${adj ? ` ${adj > 0 ? "+" : ""}${Math.round(adj * 100)}%` : ""} across ${cat.accountIds.length} account${cat.accountIds.length === 1 ? "" : "s"}`;
    meta = {
      method: "GL Average",
      sourceTotal: round2(Math.abs(totalHistory)),
      weeksUsed: divisor,
      rawAverage: round2(Math.abs(totalHistory) / divisor),
      adjustmentPct: Math.round(adj * 100),
      finalAverage: round2(weeklyAvg),
    };
    breakdown = [...accountTotals.entries()]
      .map(([name, amount]) => ({ name, amount: round2(amount), type: "Source Data" }))
      .sort((a, b) => b.amount - a.amount);
  } else if (cat.method === "vendor_payment_history" && (cat.partyIds?.length || cat.partyId)) {
    const vids = cat.partyIds?.length ? cat.partyIds : [cat.partyId!];
    const historyMonths = Math.max(1, Math.min(36, cat.historyMonths ?? 12));
    const idList = sql.join(vids.map((v) => sql`${v}`), sql`, `);
    const r = (await db.execute(sql`
      select to_char(coalesce(d.document_date, d.posting_date), 'YYYY-MM') as month, sum(abs(d.total)) as paid
      from documents d
      where d.org_id = ${orgId} and d.party_id in (${idList}) and d.voided_at is null
        and d.kind in ('vendor_payment', 'check')
        and coalesce(d.document_date, d.posting_date) > ${asOfIso}::date - (${historyMonths} || ' months')::interval
        and coalesce(d.document_date, d.posting_date) <= ${asOfIso}::date${subScope(sql`d.subsidiary_id`, context.subIds)}
      group by 1
    `));
    const months = (r.rows).map((x) => Number(x.paid)).filter((v) => v > 0).sort((a, b) => a - b);
    const mid = Math.floor(months.length / 2);
    const median = months.length ? (months.length % 2 !== 0 ? months[mid]! : (months[mid - 1]! + months[mid]!) / 2) : 0;
    let baseAmount = isSet(cat.expectedWeek) ? median : median / 4.345;
    if (adj !== 0) baseAmount = baseAmount * (1 + adj);
    weekStarts.forEach((k, i) => {
      weekly[i] = round2(baseAmount * getProrationFactor(parseISO(k), asOf, cat.expectedDay, cat.expectedWeek));
    });
    logic = `median of ${months.length} monthly payments${isSet(cat.expectedWeek) ? "" : " ÷ 4.345"}`;
    meta = {
      method: "Vendor History (Median)",
      monthlyMedian: round2(median),
      finalWeekly: round2(median / 4.345),
      vendors: vids.length,
      ...(cat.partyName ? { vendor: cat.partyName } : {}),
    };
    breakdown = (r.rows)
      .map((x) => ({ name: String(x.month), amount: round2(Number(x.paid)), type: "Source Month" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else if (cat.method === "credit_card_cycle" && (cat.cardAccountIds?.length || cat.accountIds?.length)) {
    const accountIds = cat.cardAccountIds?.length ? cat.cardAccountIds : cat.accountIds!;
    const lookbackMonths = Math.max(1, Math.min(24, cat.historyMonths ?? 6));
    const lookbackDays = lookbackMonths * 30;
    const historyStart = addDays(asOf, -lookbackDays);
    const ids = sql.join(accountIds.map((a) => sql`${a}`), sql`, `);
    // Charges push the card liability (amount < 0), payments release it (> 0).
    const r = (await db.execute(sql`
      select e.posting_date::text as day,
             sum(case when l.amount < 0 then -l.amount else 0 end) as spend,
             sum(case when l.amount > 0 then l.amount else 0 end) as paid
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      where l.org_id = ${orgId} and l.account_id in (${ids})
        and e.posting_date >= ${toISO(historyStart)} and e.posting_date <= ${asOfIso}${subScope(sql`l.subsidiary_id`, context.subIds)}
      group by 1
    `));
    const balR = (await db.execute(sql`
      select coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      where l.org_id = ${orgId} and l.account_id in (${ids}) and e.posting_date <= ${asOfIso}${subScope(sql`l.subsidiary_id`, context.subIds)}
    `));
    const totalCurrentBalance = Math.abs(Number(balR.rows[0]?.bal ?? 0));

    interface DayTotals { date: Date; spend: number; paid: number }
    const days: DayTotals[] = (r.rows as any[]).map((x) => ({ date: parseISO(x.day), spend: Number(x.spend), paid: Number(x.paid) }));
    const grandTotalSpend = days.reduce((a, d) => a + d.spend, 0);

    // Monthly payment rollups with the largest payment's day of month.
    const monthly = new Map<string, { total: number; count: number; largestDay: number | null; largestAmt: number }>();
    for (const d of days) {
      if (d.paid <= 0) continue;
      const mKey = toISO(d.date).slice(0, 7);
      const m = monthly.get(mKey) ?? { total: 0, count: 0, largestDay: null, largestAmt: 0 };
      m.total += d.paid;
      m.count += 1;
      if (d.paid > m.largestAmt) { m.largestAmt = d.paid; m.largestDay = d.date.getUTCDate(); }
      monthly.set(mKey, m);
    }
    const monthlyTotals = [...monthly.entries()]
      .map(([month, m]) => ({ month, total: m.total, paymentCount: m.count, largestPaymentDay: m.largestDay }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const currentMonth = asOfIso.slice(0, 7);
    const dayOfMonth = asOf.getUTCDate();
    const completedMonths = monthlyTotals.filter((m) =>
      m.month < currentMonth || (m.month === currentMonth && m.total > 0 && m.largestPaymentDay !== null && dayOfMonth >= m.largestPaymentDay));

    let medianPayment = 0;
    let avgPayment = 0;
    let paymentTrend = 0;
    if (completedMonths.length > 0) {
      const amounts = completedMonths.map((m) => m.total);
      const sorted = [...amounts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianPayment = sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      avgPayment = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      if (completedMonths.length >= 4) {
        const recent = completedMonths.slice(-3);
        const older = completedMonths.slice(0, -3);
        const recentAvg = recent.reduce((s, m) => s + m.total, 0) / recent.length;
        const olderAvg = older.reduce((s, m) => s + m.total, 0) / older.length;
        paymentTrend = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;
      }
    } else {
      const monthlySpendRate = (grandTotalSpend / lookbackDays) * 30;
      medianPayment = monthlySpendRate;
      avgPayment = monthlySpendRate;
    }

    // Primary payment day (mode; median when all unique).
    const primaryDays = completedMonths.filter((m) => m.largestPaymentDay !== null).map((m) => m.largestPaymentDay!);
    let detectedPaymentDay = 24;
    if (primaryDays.length > 0) {
      const counts = new Map<number, number>();
      for (const d of primaryDays) counts.set(d, (counts.get(d) ?? 0) + 1);
      let maxCount = 0;
      for (const [day, count] of counts) if (count > maxCount) { maxCount = count; detectedPaymentDay = day; }
      if (maxCount === 1 && primaryDays.length > 1) {
        const sortedDays = [...primaryDays].sort((a, b) => a - b);
        detectedPaymentDay = sortedDays[Math.floor(sortedDays.length / 2)]!;
      }
    }

    const dailyBurnRate = grandTotalSpend / lookbackDays;
    const effectiveThreshold = (cat.significantPaymentThreshold ?? 0) > 0
      ? cat.significantPaymentThreshold!
      : medianPayment > 0 ? medianPayment * 0.5 : 10000;
    const significantPayments = days.filter((d) => d.paid > effectiveThreshold).sort((a, b) => b.date.getTime() - a.date.getTime());
    const lastPaymentDate = significantPayments[0]?.date ?? null;
    const daysSinceLastPayment = lastPaymentDate ? Math.ceil((asOf.getTime() - lastPaymentDate.getTime()) / MS_DAY) : 30;

    let nextPaymentDate = new Date(asOf);
    nextPaymentDate.setUTCDate(Math.min(detectedPaymentDay, daysInMonthUTC(nextPaymentDate)));
    if (nextPaymentDate <= asOf) {
      nextPaymentDate = addMonthsUTC(nextPaymentDate, 1);
      nextPaymentDate.setUTCDate(Math.min(detectedPaymentDay, daysInMonthUTC(nextPaymentDate)));
    }
    nextPaymentDate = businessDay(nextPaymentDate);

    // Projected growth to statement close, then trajectory/median blend.
    const daysFromPaymentToStatementClose = 27;
    const cycleProgress = medianPayment > 0 ? Math.min(totalCurrentBalance / medianPayment, 1) : 1;
    const daysRemainingToAccrue = Math.max(0, daysFromPaymentToStatementClose - cycleProgress * daysFromPaymentToStatementClose);
    const trajectoryEstimate = totalCurrentBalance + dailyBurnRate * daysRemainingToAccrue;
    const varianceFromMedian = medianPayment > 0 ? Math.abs(trajectoryEstimate - medianPayment) / medianPayment : 0;
    let projectedPayment: number;
    let projectionMethod: string;
    if (varianceFromMedian <= 0.2) {
      projectedPayment = trajectoryEstimate;
      projectionMethod = "Current Cycle Trajectory";
    } else if (trajectoryEstimate < medianPayment) {
      projectedPayment = medianPayment;
      projectionMethod = "Historical Median (Low Trajectory)";
    } else {
      projectedPayment = medianPayment * 0.7 + trajectoryEstimate * 0.3;
      projectionMethod = "Blended (High Trajectory)";
    }

    breakdown = completedMonths.map((m) => ({
      name: new Date(m.month + "-01T00:00:00Z").toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
      amount: round2(m.total),
      type: "Historical",
      details: `${m.paymentCount} payment(s), Day ${m.largestPaymentDay}`,
    }));
    let paymentDate = new Date(nextPaymentDate);
    let isFirstPayment = true;
    while (paymentDate <= tEnd) {
      const wk = toISO(weekStart(paymentDate));
      const amountToPay = round2(isFirstPayment ? projectedPayment : medianPayment);
      put(wk, amountToPay);
      if (isFirstPayment) {
        breakdown.unshift({ name: "Next Payment", amount: amountToPay, date: toISO(paymentDate), type: "Projection", details: projectionMethod });
        isFirstPayment = false;
      }
      paymentDate = addMonthsUTC(paymentDate, 1);
      paymentDate.setUTCDate(Math.min(detectedPaymentDay, daysInMonthUTC(paymentDate)));
      paymentDate = businessDay(paymentDate);
    }
    breakdown.push({ name: "Current Balance", amount: round2(totalCurrentBalance), type: "Info", details: `${daysSinceLastPayment} days since last payment` });

    logic = `card cycle · pays day ${detectedPaymentDay} · median ${Math.round(medianPayment).toLocaleString()}`;
    meta = {
      method: "Credit Card Cycle",
      detectedPaymentDay,
      medianPayment: round2(medianPayment),
      avgPayment: round2(avgPayment),
      currentBalance: round2(totalCurrentBalance),
      daysSinceLastPayment,
      dailyBurnRate: round2(dailyBurnRate),
      monthlySpendRate: round2(dailyBurnRate * 30),
      paymentTrend: `${round2(paymentTrend)}%`,
      monthsAnalyzed: completedMonths.length,
      accountsIncluded: accountIds.length,
      nextPaymentDate: toISO(nextPaymentDate),
      projectedGrowth: round2(projectedPayment - totalCurrentBalance),
    };
  } else if (cat.method === "formula_expression" && cat.formula) {
    let expression = cat.formula.toUpperCase();
    expression = expression
      .replace(/IF\s*\(([^,]+),([^,]+),([^)]+)\)/g, "($1 ? $2 : $3)")
      .replace(/MAX\(/g, "max(").replace(/MIN\(/g, "min(").replace(/ABS\(/g, "abs(")
      .replace(/CEIL\(/g, "ceil(").replace(/FLOOR\(/g, "floor(").replace(/ROUND\(/g, "round(")
      .replace(/SQRT\(/g, "sqrt(").replace(/POW\(/g, "pow(").replace(/AVG\(/g, "avg(");
    weekStarts.forEach((k, i) => {
      const cur = parseISO(k);
      const weekIndex = i + 1;
      const valAR = context.arWeekly[k] ?? 0;
      const valAP = context.apWeekly[k] ?? 0;
      const monthNum = cur.getUTCMonth() + 1;
      const dayOfMonth = cur.getUTCDate();
      const weekEnd = addDays(cur, 6);
      const isMonthStart = dayOfMonth <= 7 ? 1 : 0;
      const isMonthEnd = weekEnd.getUTCMonth() !== cur.getUTCMonth() || dayOfMonth >= 25 ? 1 : 0;
      const evalStr = expression
        .replace(/{AR_IN}/g, String(valAR)).replace(/{AP_OUT}/g, String(valAP))
        .replace(/{NET_FLOW}/g, String(valAR - valAP)).replace(/{CASH_START}/g, String(context.cashStart))
        .replace(/{WEEK_NUM}/g, String(weekIndex)).replace(/{MONTH}/g, String(monthNum))
        .replace(/{QUARTER}/g, String(Math.ceil(monthNum / 3))).replace(/{YEAR}/g, String(cur.getUTCFullYear()))
        .replace(/{DAY}/g, String(dayOfMonth))
        .replace(/{IS_WK1}/g, weekIndex === 1 ? "1" : "0").replace(/{IS_WK2}/g, weekIndex === 2 ? "1" : "0")
        .replace(/{IS_WK3}/g, weekIndex === 3 ? "1" : "0").replace(/{IS_WK4}/g, weekIndex === 4 ? "1" : "0")
        .replace(/{IS_WK5}/g, weekIndex >= 5 ? "1" : "0")
        .replace(/{IS_MONTH_START}/g, String(isMonthStart)).replace(/{IS_MONTH_END}/g, String(isMonthEnd))
        .replace(/{IS_Q_START}/g, monthNum % 3 === 1 && isMonthStart ? "1" : "0")
        .replace(/{IS_Q_END}/g, monthNum % 3 === 0 && isMonthEnd ? "1" : "0")
        .replace(/{IS_YEAR_END}/g, monthNum === 12 && isMonthEnd ? "1" : "0")
        .replace(/{TAX_RATE}/g, "0.13").replace(/{TRUE}/g, "1").replace(/{FALSE}/g, "0");
      let result = 0;
      try {
        result = evaluateFormula(evalStr);
        if (!isFinite(result)) result = 0;
      } catch {
        result = 0;
      }
      weekly[i] = round2(result);
    });
    logic = cat.formula.length > 60 ? `${cat.formula.slice(0, 57)}…` : cat.formula;
    meta = { method: "Calculated Formula", formula: cat.formula };
    breakdown = [{ name: "Computed via Formula", amount: round2(weekly.reduce((a, v) => a + v, 0)), type: "Formula" }];
  } else if (cat.method === "vendor_recurring_average" && (cat.partyIds?.length || cat.partyId)) {
    const vids = cat.partyIds?.length ? cat.partyIds : [cat.partyId!];
    const historyMonths = Math.max(1, Math.min(36, cat.historyMonths ?? 3));
    const idList = sql.join(vids.map((v) => sql`${v}`), sql`, `);
    const r = (await db.execute(sql`
      select coalesce(d.document_date, d.posting_date)::text as day, sum(abs(d.total)) as paid
      from documents d
      where d.org_id = ${orgId} and d.party_id in (${idList}) and d.voided_at is null
        and d.kind in ('vendor_payment', 'check')
        and coalesce(d.document_date, d.posting_date) >= ${asOfIso}::date - (${historyMonths} || ' months')::interval${subScope(sql`d.subsidiary_id`, context.subIds)}
      group by 1
    `));
    const events = (r.rows as any[])
      .map((x) => ({ date: parseISO(x.day), amount: Number(x.paid) }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    if (events.length >= 2) {
      const intervals: number[] = [];
      for (let i = 0; i < events.length - 1; i++) {
        intervals.push(Math.ceil(Math.abs(events[i]!.date.getTime() - events[i + 1]!.date.getTime()) / MS_DAY));
      }
      intervals.sort((a, b) => a - b);
      const medianInterval = intervals[Math.floor(intervals.length / 2)]!;
      let frequencyLabel = "Monthly";
      let nextIntervalDays = 30;
      if (medianInterval >= 5 && medianInterval <= 9) { frequencyLabel = "Weekly"; nextIntervalDays = 7; }
      else if (medianInterval >= 12 && medianInterval <= 16) { frequencyLabel = "Bi-Weekly"; nextIntervalDays = 14; }
      const amounts = events.map((e) => e.amount);
      const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length;
      const stdDev = Math.sqrt(variance);
      let filtered = amounts;
      if (amounts.length >= 4 && stdDev > 0) filtered = amounts.filter((a) => Math.abs(a - mean) <= 2 * stdDev);
      let avgAmount = filtered.reduce((a, b) => a + b, 0) / filtered.length;
      if (adj !== 0) avgAmount = avgAmount * (1 + adj);
      let nextDate = addDays(events[0]!.date, nextIntervalDays);
      while (nextDate < asOf) nextDate = addDays(nextDate, nextIntervalDays);
      while (nextDate <= tEnd) {
        put(toISO(weekStart(nextDate)), round2(avgAmount));
        nextDate = addDays(nextDate, nextIntervalDays);
      }
      logic = `${frequencyLabel.toLowerCase()} cadence auto-detected · avg ${Math.round(avgAmount).toLocaleString()}`;
      meta = {
        method: "Vendor Recurring (Auto)",
        frequency: frequencyLabel,
        avgAmount: round2(avgAmount),
        samples: events.length,
        interval: medianInterval,
        vendors: vids.length,
      };
    } else {
      logic = "not enough payment history to detect a cadence";
      meta = { method: "Vendor Recurring (Auto)", samples: events.length };
    }
    breakdown = events.map((e) => ({ name: "Historical Payment", amount: round2(e.amount), date: toISO(e.date), type: "Source Data" }));
  } else if (cat.method === "bank_register_history" && cat.bankAccountIds?.length) {
    const historyWeeks = Math.max(1, Math.min(52, cat.historyWeeks ?? 12));
    const historyStart = addDays(tStart, -historyWeeks * 7);
    const ids = sql.join(cat.bankAccountIds.map((a) => sql`${a}`), sql`, `);
    const includeTransfers = cat.includeTransfers !== false;
    const includeChecks = cat.includeChecks !== false;
    const includeJournals = cat.includeJournals === true;
    const kindClauses = [];
    if (includeTransfers) kindClauses.push(sql`d.kind = 'transfer'`);
    if (includeChecks) kindClauses.push(sql`d.kind in ('vendor_payment', 'check')`);
    if (includeJournals) kindClauses.push(sql`d.id is null`);
    if (kindClauses.length === 0) kindClauses.push(sql`false`);
    const kindFilter = sql.join(kindClauses, sql` or `);
    const keywords = (cat.memoKeywords ?? []).map((k) => k.trim()).filter(Boolean);
    const memoFilter = keywords.length
      ? sql` and (${sql.join(keywords.map((k) => sql`coalesce(d.memo, e.memo, '') ilike ${"%" + k + "%"}`), sql` or `)})`
      : sql``;
    const r = (await db.execute(sql`
      select e.posting_date::text as day, coalesce(d.kind, 'journal') as kind,
             d.document_number as doc_number, coalesce(p.display_name, '') as party,
             coalesce(d.memo, e.memo, '') as memo, -l.amount as amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where l.org_id = ${orgId} and l.account_id in (${ids}) and l.amount < 0
        and e.posting_date >= ${toISO(historyStart)} and e.posting_date <= ${toISO(tEnd)}
        and (${kindFilter})${memoFilter}${subScope(sql`l.subsidiary_id`, context.subIds)}
    `));
    const weeklyHistory: Record<string, number> = {};
    const currentWeekKey = toISO(weekStart(asOf));
    const startKey = toISO(tStart);
    for (const x of r.rows as any[]) {
      const amount = Number(x.amount);
      if (amount <= 0) continue;
      const wk = toISO(weekStart(parseISO(x.day)));
      weeklyHistory[wk] = (weeklyHistory[wk] ?? 0) + amount;
      const isCurrentWeek = wk === currentWeekKey;
      if (x.day < startKey || isCurrentWeek) {
        breakdown.push({
          name: `${x.day} ${x.kind} ${x.party}${x.doc_number ? ` (${x.doc_number})` : ""}`.trim(),
          amount: round2(amount),
          date: x.day,
          type: isCurrentWeek ? "This Week (Applied)" : "Bank Register",
          ...(x.memo ? { details: String(x.memo) } : {}),
        });
      }
    }
    let totalHistory = 0;
    let weeksCounted = 0;
    for (const k of Object.keys(weeklyHistory)) {
      if (k < startKey) { totalHistory += weeklyHistory[k]!; weeksCounted++; }
    }
    const divisor = weeksCounted > 0 ? weeksCounted : historyWeeks;
    let weeklyAvg = totalHistory / divisor;
    if (adj !== 0) weeklyAvg = weeklyAvg * (1 + adj);
    weekStarts.forEach((k, i) => {
      const actual = weeklyHistory[k] ?? 0;
      let amount: number;
      if (k === currentWeekKey && actual > 0) amount = Math.max(0, weeklyAvg - actual);
      else if (actual > 0 && k > currentWeekKey) amount = actual;
      else amount = weeklyAvg;
      amount *= getProrationFactor(parseISO(k), asOf, cat.expectedDay, cat.expectedWeek);
      weekly[i] = round2(amount);
    });
    logic = `${historyWeeks}-week bank register average${adj ? ` ${adj > 0 ? "+" : ""}${Math.round(adj * 100)}%` : ""}${keywords.length ? ` · memo: ${keywords.join(", ")}` : ""}`;
    meta = {
      method: "Bank Register History",
      bankAccounts: cat.bankAccountIds.length,
      historyWeeks,
      rawAverage: round2(totalHistory / divisor || 0),
      finalAverage: round2(weeklyAvg),
      weeksUsed: divisor,
      currentWeekApplied: round2(weeklyHistory[currentWeekKey] ?? 0),
      ...(keywords.length ? { memoKeywords: keywords.join(", ") } : {}),
    };
    breakdown.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }

  return {
    id: cat.id,
    name: cat.name,
    direction: cat.direction === "inflow" ? "inflow" : "outflow",
    method: cat.method,
    weekly: weekly.map((v) => Math.round(v)),
    total: Math.round(weekly.reduce((a, v) => a + v, 0)),
    logic,
    meta,
    breakdown,
  };
}

export async function bankBalances(asOf: string, subIds?: string[]) {
  // Inception-to-date cash per bank account: whole months from the
  // gl_month_activity summary, the as-of month from the lines. Summing every
  // bank line ever posted cost seconds once a tenant had a real ledger.
  //
  // The org predicates are explicit and the movement legs are restricted to
  // bank accounts: RLS alone scopes rows correctly but its current_setting()
  // comparison is not sargable, so an unqualified leg degrades to a full scan
  // of every journal line in the table.
  const orgId = await resolveOrgId();
  const r = (await db.execute(sql`
    with bank_accounts as (
      select id from accounts
       where org_id = ${orgId} and type = 'asset_bank' and is_summary = false and is_active
    ),
    -- The as-of month's entries materialize first. Left to itself the planner
    -- reached the sliver through (org, account), which walks every bank line
    -- ever posted before the date filter applies.
    sliver_entries as materialized (
      select id from journal_entries
       where org_id = ${orgId} and status in ('posted', 'reversed')
         and posting_date >= date_trunc('month', ${asOf}::date)::date
         and posting_date <= ${asOf}
    ),
    movement as (
      select g.account_id, (g.debit_total - g.credit_total) as amt
        from gl_month_activity g
       where g.org_id = ${orgId}
         and g.account_id in (select id from bank_accounts)
         and g.month < date_trunc('month', ${asOf}::date)::date
         ${subScope(sql`g.subsidiary_id`, subIds)}
      union all
      select l.account_id, l.amount
        from sliver_entries se
        join journal_lines l on l.entry_id = se.id and l.org_id = ${orgId}
       where l.account_id in (select id from bank_accounts)
         ${subScope(sql`l.subsidiary_id`, subIds)}
    )
    select a.id, a.name, a.number, coalesce(sum(m.amt), 0) as balance
    from accounts a
    left join movement m on m.account_id = a.id
    where a.type = 'asset_bank' and a.is_summary = false and a.is_active
      ${subIds && subIds.length > 0 ? sql`and (a.subsidiary_id is null or a.subsidiary_id = any(${`{${subIds.join(",")}}`}::uuid[]))` : sql``}
    group by a.id, a.name, a.number
    order by coalesce(sum(m.amt), 0) desc
  `));
  return r.rows.map((x) => ({
    id: String(x.id),
    name: String(x.name),
    number: x.number == null ? null : String(x.number),
    balance: Number(x.balance),
  }));
}

export function bucketOf(daysPastDue: number): string {
  if (daysPastDue <= 0) return "Current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

/** Predict collection/payment date for one open item. */
export function predict(
  item: OpenItem,
  asOf: Date,
  stats: PaymentStats,
): { date: Date; method: string } {
  let date: Date;
  let method = "Global avg";
  const s = item.partyId ? stats.map.get(item.partyId) : undefined;
  if (s) {
    const buffer = s.sd ? Math.ceil(s.sd * 0.5) : 0;
    date = addDays(item.tranDate, Math.round(s.avg) + buffer);
    method = "Statistical";
  } else {
    date = addDays(item.tranDate, stats.globalAvg);
  }
  // Floor at due date.
  if (item.dueDate && date < item.dueDate) {
    date = item.dueDate;
    method = "Due date";
  }
  // Overdue → push forward.
  if (date < asOf) {
    const overdue = daysBetween(date, asOf);
    const push = overdue > 60 ? 28 : overdue > 30 ? 14 : 7;
    date = addDays(asOf, push);
    method = "Overdue push";
  }
  return { date: businessDay(date), method };
}

export function summariseSide(items: OpenItem[], asOf: Date, scheduled: number, avgDays: number): SideSummary {
  const buckets = new Map<string, number>([
    ["Current", 0], ["1-30", 0], ["31-60", 0], ["61-90", 0], ["90+", 0],
  ]);
  let outstanding = 0;
  for (const it of items) {
    outstanding += it.remaining;
    const dpd = it.dueDate ? daysBetween(it.dueDate, asOf) : 0;
    const b = bucketOf(dpd);
    buckets.set(b, (buckets.get(b) ?? 0) + it.remaining);
  }
  const current = buckets.get("Current") ?? 0;
  return {
    outstanding,
    scheduled,
    pctCurrent: outstanding > 0 ? (current / outstanding) * 100 : 0,
    avgDays,
    buckets: [...buckets.entries()].map(([label, amount]) => ({ label, amount })),
  };
}

/**
 * Predict every open item into a week bucket ( /
 * buildAPForecast). Returns the by-week entry map and the total scheduled
 * inside the horizon — the shared step behind the analytics timeline and the
 * cockpit worklists.
 */
export function scheduleForecast(
  items: OpenItem[],
  stats: PaymentStats,
  asOf: Date,
  start: Date,
  end: Date,
): { byWeek: Map<string, ForecastEntry[]>; entries: ForecastEntry[]; scheduled: number } {
  const byWeek = new Map<string, ForecastEntry[]>();
  const entries: ForecastEntry[] = [];
  let scheduled = 0;
  for (const it of items) {
    const { date, method } = predict(it, asOf, stats);
    if (date < start || date > end) continue;
    const wk = toISO(weekStart(date));
    const dpd = it.dueDate ? daysBetween(it.dueDate, asOf) : 0;
    const entry: ForecastEntry = {
      id: it.id,
      entryId: it.entryId,
      docKind: it.docKind,
      docNumber: it.docNumber,
      docId: it.docId,
      partyId: it.partyId,
      partyName: it.partyName,
      amount: it.remaining,
      tranDate: toISO(it.tranDate),
      dueDate: it.dueDate ? toISO(it.dueDate) : null,
      predictedDate: toISO(date),
      weekStart: wk,
      daysOverdue: Math.max(0, dpd),
      method,
    };
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk)!.push(entry);
    entries.push(entry);
    scheduled += it.remaining;
  }
  return { byWeek, entries, scheduled };
}
