import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

/**
 * Shared cash-engine core — the primitives behind BOTH the read-only analytics
 * cashflow forecast (analytics/cashflow) and the operational domain cockpits
 * (AP / AR / Banking-Cash). Everything here is a faithful port of Gantry's
 * Liquidity/Cashflow model; it was extracted verbatim from the original
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
/** Sunday of the week (Gantry getWeekStart: date − getDay()). */
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
  arEntries: ForecastEntry[];
  apEntries: ForecastEntry[];
  /** Non-AR/AP forecast flows from configured categories. */
  dynamicInflow: number;
  dynamicOutflow: number;
  /** AP scheduled but pushed to a later week by the capacity scheduler. */
  deferredOut: number;
  /** Available AP capacity this week (null = unlimited, no scheduling). */
  apCapacity: number | null;
}

/**
 * Non-AR/AP forecast category — the openbooks port of Gantry's dynamic
 * category engine (Lib_Cashflow_Data processCategory). Three of Gantry's
 * seven strategies are supported; the others need data this ledger doesn't
 * carry (statement cycles, formula variables) and are stated in the UI.
 */
export interface ForecastCategory {
  id: string;
  name: string;
  direction: "inflow" | "outflow";
  method: "gl_history_average" | "vendor_payment_history" | "manual_recurring";
  // gl_history_average
  accountIds?: string[];
  historyWeeks?: number; // default 12
  adjustmentPct?: number; // default 0
  // vendor_payment_history
  partyId?: string;
  partyName?: string;
  // manual_recurring
  amount?: number;
  frequency?: "weekly" | "biweekly" | "monthly";
}

export interface CategoryWeekly {
  id: string;
  name: string;
  direction: "inflow" | "outflow";
  method: ForecastCategory["method"];
  weekly: number[]; // aligned with weeks[]
  total: number;
  /** Human explanation of the computation (Gantry's Forecast Logic card). */
  logic: string;
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
  docId: string | null;
  partyId: string | null;
  partyName: string;
  tranDate: Date;
  dueDate: Date | null;
  remaining: number;
}

export type PaymentStats = { map: Map<string, { avg: number; sd: number }>; globalAvg: number };

/** A resolved week grid for a horizon anchored at `asOf`. */
export interface WeekGrid {
  asOfIso: string;
  asOf: Date;
  start: Date;
  end: Date;
  weekStarts: string[];
}

/** Build the Sunday-aligned week grid for a horizon (Gantry buildFinalTimeline). */
export function buildWeekGrid(asOfIso: string, horizonWeeks: number): WeekGrid {
  const asOf = parseISO(asOfIso);
  const start = weekStart(asOf);
  const end = addDays(start, horizonWeeks * 7 - 1);
  const weekStarts: string[] = [];
  for (let cur = new Date(start); cur <= end; cur = addDays(cur, 7)) weekStarts.push(toISO(cur));
  return { asOfIso, asOf, start, end, weekStarts };
}

/** Clamp an as-of date to today (never forecast from the future). */
export function resolveAsOf(asOfDate?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return asOfDate && asOfDate < today ? asOfDate : today;
}

export async function openItems(side: Side, asOf: string): Promise<OpenItem[]> {
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  // The CASH cockpit deals in payable/receivable DOCUMENTS — the things a
  // pay run pays and a collections run collects. Journal legs on the control
  // accounts (month-end accruals, opening balances, reversals) are real GL and
  // belong to aging/reconciliation surfaces, but they are NOT payables: an
  // accrual journal must never appear in "Open payables" or the pay-run
  // planner. Settlements drain from BOTH application roles (a journal-netted
  // bill is just as paid as a payment-settled one).
  const kindFilter = side === "ap"
    ? sql`d.kind in ('vendor_bill', 'expense_report')`
    : sql`d.kind = 'customer_invoice'`;
  const r = (await db.execute(sql`
    with oi as (
      select jl.id, jl.party_id, jl.entry_id, je.posting_date as tran_date, jl.due_date,
             je.source_document_id as doc_id,
             abs(jl.amount) - coalesce((
               select sum(x.amount) from applications x
                where (x.to_line_id = jl.id or x.from_line_id = jl.id) and x.unapplied_at is null
             ), 0) as remaining
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
        join accounts a on a.id = jl.account_id
       where jl.is_open_item and a.type = ${acctType} and ${signFilter}
         and je.posting_date <= ${asOf}
    )
    select oi.id, oi.entry_id, oi.doc_id, d.kind as doc_kind, oi.party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           oi.tran_date, oi.due_date, oi.remaining
      from oi
      join documents d on d.id = oi.doc_id and ${kindFilter}
      left join parties p on p.id = oi.party_id
     where oi.remaining > 0.005
  `)) as any;
  return (r.rows as any[]).map((x) => ({
    id: x.id,
    entryId: x.entry_id,
    docKind: x.doc_kind ?? null,
    docId: x.doc_id ?? null,
    partyId: x.party_id,
    partyName: x.party_name,
    tranDate: parseISO(x.tran_date),
    dueDate: x.due_date ? parseISO(x.due_date) : null,
    remaining: Number(x.remaining),
  }));
}

/**
 * Per-party avg days (+ σ) from invoice/bill date to the applied payment.
 * Gantry parity: history restricted to the trailing 365 days (paymentHistoryDays),
 * global average weighted by data point (globalSum/globalCount over all payments,
 * not an average of per-party averages), and 45-day default when no history exists.
 */
export async function paymentStats(side: Side, asOfIso: string): Promise<PaymentStats> {
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  const r = (await db.execute(sql`
    select bl.party_id as id,
      avg(pe.posting_date - be.posting_date) as avg_days,
      coalesce(stddev_pop(pe.posting_date - be.posting_date), 0) as sd_days,
      count(*) as n
    from applications a
    join journal_lines bl on bl.id = a.to_line_id
    join journal_entries be on be.id = bl.entry_id
    join journal_lines pl on pl.id = a.from_line_id
    join journal_entries pe on pe.id = pl.entry_id
    join accounts ba on ba.id = bl.account_id
    where ba.type = ${acctType} and a.unapplied_at is null and bl.party_id is not null
      and pe.posting_date >= ${asOfIso}::date - interval '365 days'
      and pe.posting_date <= ${asOfIso}::date
    group by bl.party_id
  `)) as any;
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
  `)) as any;
  const raw = r.rows[0]?.cats;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c: any) => c && typeof c === "object" && c.id && c.name && c.method);
}

/**
 * Compute one category's weekly amounts across the horizon — the three
 * portable Gantry strategies:
 *  - gl_history_average: |net GL activity| on the chosen accounts over the
 *    trailing historyWeeks (default 12) ÷ weeks × (1 + adjustment%).
 *  - vendor_payment_history: median non-zero monthly outflow to the vendor
 *    over the trailing 12 months ÷ 4.345 (Gantry's month→week factor).
 *  - manual_recurring: fixed amount weekly / every 2nd week / on the first
 *    week of each calendar month.
 */
export async function categoryWeekly(
  orgId: string,
  cat: ForecastCategory,
  asOfIso: string,
  weekStarts: string[],
): Promise<CategoryWeekly> {
  const n = weekStarts.length;
  const weekly = new Array<number>(n).fill(0);
  let logic = "";

  if (cat.method === "manual_recurring") {
    const amount = Math.abs(cat.amount ?? 0);
    const freq = cat.frequency ?? "monthly";
    if (freq === "weekly") weekly.fill(amount);
    else if (freq === "biweekly") for (let i = 0; i < n; i += 2) weekly[i] = amount;
    else {
      let lastMonth = "";
      weekStarts.forEach((w, i) => {
        const m = w.slice(0, 7);
        if (m !== lastMonth) { weekly[i] = amount; lastMonth = m; }
      });
    }
    logic = `$${Math.round(amount).toLocaleString()} ${freq}`;
  } else if (cat.method === "gl_history_average" && cat.accountIds?.length) {
    const historyWeeks = Math.max(1, Math.min(52, cat.historyWeeks ?? 12));
    const adj = (cat.adjustmentPct ?? 0) / 100;
    const ids = sql.join(cat.accountIds.map((a) => sql`${a}`), sql`, `);
    const r = (await db.execute(sql`
      select coalesce(sum(l.amount), 0) as total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      where l.org_id = ${orgId} and l.account_id in (${ids})
        and e.posting_date > ${asOfIso}::date - (${historyWeeks} * 7)::int
        and e.posting_date <= ${asOfIso}::date
    `)) as any;
    const perWeek = (Math.abs(Number(r.rows[0]?.total ?? 0)) / historyWeeks) * (1 + adj);
    weekly.fill(perWeek);
    logic = `${historyWeeks}-week GL average${adj ? ` ${adj > 0 ? "+" : ""}${Math.round(adj * 100)}%` : ""} across ${cat.accountIds.length} account${cat.accountIds.length === 1 ? "" : "s"}`;
  } else if (cat.method === "vendor_payment_history" && cat.partyId) {
    const r = (await db.execute(sql`
      select to_char(coalesce(d.document_date, d.posting_date), 'YYYY-MM') as month, sum(abs(d.total)) as paid
      from documents d
      where d.org_id = ${orgId} and d.party_id = ${cat.partyId} and d.voided_at is null
        and d.kind in ('vendor_payment', 'check')
        and coalesce(d.document_date, d.posting_date) > ${asOfIso}::date - interval '12 months'
        and coalesce(d.document_date, d.posting_date) <= ${asOfIso}::date
      group by 1
    `)) as any;
    const months = (r.rows as any[]).map((x) => Number(x.paid)).filter((v) => v > 0).sort((a, b) => a - b);
    const median = months.length ? months[Math.floor(months.length / 2)]! : 0;
    const perWeek = median / 4.345;
    weekly.fill(perWeek);
    logic = `median of ${months.length} monthly payments ÷ 4.345`;
  }

  return {
    id: cat.id,
    name: cat.name,
    direction: cat.direction === "inflow" ? "inflow" : "outflow",
    method: cat.method,
    weekly: weekly.map((v) => Math.round(v)),
    total: Math.round(weekly.reduce((a, v) => a + v, 0)),
    logic,
  };
}

export async function bankBalances(asOf: string) {
  const r = (await db.execute(sql`
    select a.id, a.name, a.number, coalesce(sum(l.amount), 0) as balance
    from accounts a
    left join (journal_lines l join journal_entries e on e.id = l.entry_id)
      on l.account_id = a.id and e.posting_date <= ${asOf}
    where a.type = 'asset_bank' and a.is_summary = false
    group by a.id, a.name, a.number
    order by coalesce(sum(l.amount), 0) desc
  `)) as any;
  return (r.rows as any[]).map((x) => ({ id: x.id, name: x.name, number: x.number, balance: Number(x.balance) }));
}

export function bucketOf(daysPastDue: number): string {
  if (daysPastDue <= 0) return "Current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

/** Predict collection/payment date for one open item (Gantry logic). */
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
 * Predict every open item into a week bucket (Gantry buildARForecast /
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
