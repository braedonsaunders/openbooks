import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

/**
 * Cash Flow forecasting — faithful port of Gantry's Liquidity/Cashflow
 * dashboard. Projects a weekly cash timeline over a horizon (4/8/12 weeks):
 *
 *  1. Start from current bank balance.
 *  2. For every open receivable/payable, PREDICT a collection/payment date:
 *     entity payment-behaviour stats (avg days + ½σ buffer) → else global avg,
 *     floored at the due date; overdue items pushed forward (+7/+14/+28d by how
 *     overdue), snapped to a business day (Gantry's buildARForecast/buildAPForecast).
 *  3. Bucket predicted amounts into Sunday-start weeks, roll a running cash
 *     balance forward, and surface runway / lowest point / vitals.
 *
 * All dates are handled as UTC-midnight to match the ledger's date columns.
 */

const MS_DAY = 86_400_000;
const parseISO = (s: string) => new Date(s + "T00:00:00Z");
const toISO = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_DAY);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MS_DAY);
/** Sunday of the week (Gantry getWeekStart: date − getDay()). */
const weekStart = (d: Date) => addDays(d, -d.getUTCDay());
/** Weekend → next business day (Sat +2, Sun +1). */
const businessDay = (d: Date) => {
  const day = d.getUTCDay();
  if (day === 6) return addDays(d, 2);
  if (day === 0) return addDays(d, 1);
  return d;
};
const weekLabel = (d: Date) => {
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
}
export interface SideSummary {
  outstanding: number;
  scheduled: number; // amount predicted within the horizon
  pctCurrent: number;
  avgDays: number;
  buckets: Bucket[];
}

export interface CashflowData {
  asOf: string;
  horizonWeeks: number;
  startingCash: number;
  bankAccounts: { id: string; name: string; number: string | null; balance: number }[];
  weeks: WeekRow[];
  summary: {
    startingCash: number;
    projectedEnd: number;
    totalInflows: number;
    totalOutflows: number;
    netChange: number;
    lowestCash: number;
    lowestWeek: string;
    burnRate: number; // avg weekly outflow
    runwayWeeks: number | null;
    runwayStatus: "healthy" | "caution" | "critical";
    arCoverage: number | null; // receivables / outflows
    dso: number | null;
    dpo: number | null;
  };
  ar: SideSummary;
  ap: SideSummary;
}

interface OpenItem {
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

async function openItems(side: Side, asOf: string): Promise<OpenItem[]> {
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  const r = (await db.execute(sql`
    with oi as (
      select jl.id, jl.party_id, jl.entry_id, je.posting_date as tran_date, jl.due_date,
             je.source_document_id as doc_id,
             abs(jl.amount) - coalesce((
               select sum(x.amount) from applications x where x.to_line_id = jl.id and x.unapplied_at is null
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
      left join parties p on p.id = oi.party_id
      left join documents d on d.id = oi.doc_id
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

/** Per-party avg days (+ σ) from invoice/bill date to the applied payment. */
async function paymentStats(side: Side): Promise<{ map: Map<string, { avg: number; sd: number }>; globalAvg: number }> {
  const acctType = side === "ar" ? "asset_receivable" : "liability_payable";
  const r = (await db.execute(sql`
    select bl.party_id as id,
      avg(pe.posting_date - be.posting_date) as avg_days,
      coalesce(stddev_pop(pe.posting_date - be.posting_date), 0) as sd_days
    from applications a
    join journal_lines bl on bl.id = a.to_line_id
    join journal_entries be on be.id = bl.entry_id
    join journal_lines pl on pl.id = a.from_line_id
    join journal_entries pe on pe.id = pl.entry_id
    join accounts ba on ba.id = bl.account_id
    where ba.type = ${acctType} and a.unapplied_at is null and bl.party_id is not null
    group by bl.party_id
  `)) as any;
  const map = new Map<string, { avg: number; sd: number }>();
  let sum = 0;
  let count = 0;
  for (const x of r.rows as any[]) {
    const avg = Number(x.avg_days);
    map.set(x.id, { avg, sd: Number(x.sd_days) });
    sum += avg;
    count++;
  }
  return { map, globalAvg: count > 0 ? Math.round(sum / count) : 30 };
}

async function bankBalances(asOf: string) {
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

function bucketOf(daysPastDue: number): string {
  if (daysPastDue <= 0) return "Current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

/** Predict collection/payment date for one open item (Gantry logic). */
function predict(
  item: OpenItem,
  asOf: Date,
  stats: { map: Map<string, { avg: number; sd: number }>; globalAvg: number },
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

function summariseSide(items: OpenItem[], asOf: Date, scheduled: number, avgDays: number): SideSummary {
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

export async function cashflowData(horizonWeeks: number, asOfDate?: string): Promise<CashflowData> {
  const today = new Date().toISOString().slice(0, 10);
  const asOfIso = asOfDate && asOfDate < today ? asOfDate : today;
  const asOf = parseISO(asOfIso);
  const start = weekStart(asOf);
  const end = addDays(start, horizonWeeks * 7 - 1);

  const [arItems, apItems, arStats, apStats, banks] = await Promise.all([
    openItems("ar", asOfIso),
    openItems("ap", asOfIso),
    paymentStats("ar"),
    paymentStats("ap"),
    bankBalances(asOfIso),
  ]);

  const startingCash = banks.reduce((a, b) => a + b.balance, 0);

  // Predict each item into a week bucket.
  const arByWeek = new Map<string, ForecastEntry[]>();
  const apByWeek = new Map<string, ForecastEntry[]>();
  let arScheduled = 0;
  let apScheduled = 0;

  const schedule = (items: OpenItem[], stats: typeof arStats, into: Map<string, ForecastEntry[]>): number => {
    let total = 0;
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
        partyName: it.partyName,
        amount: it.remaining,
        tranDate: toISO(it.tranDate),
        dueDate: it.dueDate ? toISO(it.dueDate) : null,
        predictedDate: toISO(date),
        weekStart: wk,
        daysOverdue: Math.max(0, dpd),
        method,
      };
      if (!into.has(wk)) into.set(wk, []);
      into.get(wk)!.push(entry);
      total += it.remaining;
    }
    return total;
  };
  arScheduled = schedule(arItems, arStats, arByWeek);
  apScheduled = schedule(apItems, apStats, apByWeek);

  // Roll the weekly timeline.
  const weeks: WeekRow[] = [];
  let running = startingCash;
  let totalIn = 0;
  let totalOut = 0;
  for (let cur = new Date(start); cur <= end; cur = addDays(cur, 7)) {
    const k = toISO(cur);
    const arEntries = (arByWeek.get(k) ?? []).sort((a, b) => b.amount - a.amount);
    const apEntries = (apByWeek.get(k) ?? []).sort((a, b) => b.amount - a.amount);
    const inflow = arEntries.reduce((a, e) => a + e.amount, 0);
    const outflow = apEntries.reduce((a, e) => a + e.amount, 0);
    const net = inflow - outflow;
    const startingWk = running;
    running += net;
    totalIn += inflow;
    totalOut += outflow;
    weeks.push({
      weekStart: k,
      weekEnd: toISO(addDays(cur, 6)),
      label: `${weekLabel(cur)} – ${weekLabel(addDays(cur, 6))}`,
      inflow,
      outflow,
      net,
      startingCash: startingWk,
      endingCash: running,
      arEntries,
      apEntries,
    });
  }

  // Lowest point.
  let lowestCash = startingCash;
  let lowestWeek = toISO(start);
  for (const w of weeks) {
    if (w.endingCash < lowestCash) {
      lowestCash = w.endingCash;
      lowestWeek = w.weekStart;
    }
  }

  const burnRate = weeks.length ? totalOut / weeks.length : 0;
  // Runway: weeks of cash at the current burn rate (net of inflows if positive).
  const netBurn = burnRate - (weeks.length ? totalIn / weeks.length : 0);
  const runwayWeeks = netBurn > 0 && startingCash > 0 ? startingCash / netBurn : startingCash > 0 ? null : 0;
  const runwayStatus: "healthy" | "caution" | "critical" =
    lowestCash < 0 ? "critical" : runwayWeeks !== null && runwayWeeks < 8 ? "caution" : "healthy";

  const arSummary = summariseSide(arItems, asOf, arScheduled, arStats.globalAvg);
  const apSummary = summariseSide(apItems, asOf, apScheduled, apStats.globalAvg);

  return {
    asOf: asOfIso,
    horizonWeeks,
    startingCash,
    bankAccounts: banks,
    weeks,
    summary: {
      startingCash,
      projectedEnd: running,
      totalInflows: totalIn,
      totalOutflows: totalOut,
      netChange: totalIn - totalOut,
      lowestCash,
      lowestWeek,
      burnRate,
      runwayWeeks,
      runwayStatus,
      arCoverage: totalOut > 0 ? arSummary.outstanding / totalOut : null,
      dso: arStats.globalAvg,
      dpo: apStats.globalAvg,
    },
    ar: arSummary,
    ap: apSummary,
  };
}
