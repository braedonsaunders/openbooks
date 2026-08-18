import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  addDays,
  bankBalances,
  buildWeekGrid,
  categoryWeekly,
  loadCategories,
  openItems,
  parseISO,
  paymentStats,
  resolveAsOf,
  scheduleForecast,
  toISO,
  weekLabel,
  type CategoryWeekly,
  type ForecastEntry,
  type WeekRow,
} from "./core";

/** AP capacity-scheduling knobs (the cashflow config). */
export interface ApSettings {
  weeklyCap: number;
  restrictToSafe: boolean;
}

export interface TimelineResult {
  weeks: WeekRow[];
  totalInflows: number;
  totalOutflows: number;
  /** AP predicted inside the horizon but unpayable under the cap — spills past the end. */
  deferredBeyondHorizon: number;
}

/**
 * Roll the weekly cash timeline — . Category flows
 * join AR/AP each week; when AP scheduling is on, payables are paid
 * oldest-due-first up to that week's capacity and the remainder defers forward.
 *
 * Extracted verbatim from the original analytics engine so the analytics
 * forecast, the AP pay-run planner and the Banking cash page all roll cash the
 * exact same way.
 */
export function buildTimeline(args: {
  weekStarts: string[];
  startingCash: number;
  arByWeek: Map<string, ForecastEntry[]>;
  apByWeek: Map<string, ForecastEntry[]>;
  categories: CategoryWeekly[];
  apSettings: ApSettings;
}): TimelineResult {
  const { weekStarts, startingCash, arByWeek, apByWeek, categories, apSettings } = args;
  const schedulingOn = apSettings.weeklyCap > 0 || apSettings.restrictToSafe;

  const weeks: WeekRow[] = [];
  let running = startingCash;
  let totalIn = 0;
  let totalOut = 0;
  let backlog: ForecastEntry[] = [];
  weekStarts.forEach((k, wi) => {
    const cur = parseISO(k);
    const arEntries = (arByWeek.get(k) ?? []).sort((a, b) => b.amount - a.amount);
    const dueThisWeek = apByWeek.get(k) ?? [];
    const dynamicInflow = categories.filter((c) => c.direction === "inflow").reduce((a, c) => a + (c.weekly[wi] ?? 0), 0);
    const dynamicOutflow = categories.filter((c) => c.direction === "outflow").reduce((a, c) => a + (c.weekly[wi] ?? 0), 0);
    const arInflow = arEntries.reduce((a, e) => a + e.amount, 0);

    let apEntries: ForecastEntry[];
    let deferredOut = 0;
    let apCapacity: number | null = null;
    if (schedulingOn) {
      // Oldest due date first, then largest amount (the backlog order).
      backlog = [...backlog, ...dueThisWeek].sort((a, b) => {
        const ad = a.dueDate ?? a.predictedDate;
        const bd = b.dueDate ?? b.predictedDate;
        return ad < bd ? -1 : ad > bd ? 1 : b.amount - a.amount;
      });
      const safe = apSettings.restrictToSafe ? Math.max(0, running + arInflow + dynamicInflow - dynamicOutflow) : Infinity;
      const cap = Math.min(apSettings.weeklyCap > 0 ? apSettings.weeklyCap : Infinity, safe);
      apCapacity = Number.isFinite(cap) ? cap : null;
      const paid: ForecastEntry[] = [];
      let spent = 0;
      const remaining: ForecastEntry[] = [];
      for (const e of backlog) {
        if (apCapacity === null || spent + e.amount <= apCapacity) {
          spent += e.amount;
          paid.push(e.weekStart === k ? e : { ...e, weekStart: k, method: `${e.method} (deferred from ${e.weekStart})` });
        } else {
          remaining.push(e);
        }
      }
      backlog = remaining;
      deferredOut = remaining.reduce((a, e) => a + e.amount, 0);
      apEntries = paid.sort((a, b) => b.amount - a.amount);
    } else {
      apEntries = dueThisWeek.sort((a, b) => b.amount - a.amount);
    }

    const apOutflow = apEntries.reduce((a, e) => a + e.amount, 0);
    const inflow = arInflow + dynamicInflow;
    const outflow = apOutflow + dynamicOutflow;
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
      arTotal: arInflow,
      apTotal: apEntries.reduce((a, e) => a + e.amount, 0),
      arCount: arEntries.length,
      apCount: apEntries.length,
      dynamicInflow,
      dynamicOutflow,
      deferredOut,
      apCapacity,
    });
  });
  const deferredBeyondHorizon = backlog.reduce((a, e) => a + e.amount, 0);
  return { weeks, totalInflows: totalIn, totalOutflows: totalOut, deferredBeyondHorizon };
}

export interface CashPosition {
  asOf: string;
  horizonWeeks: number;
  startingCash: number;
  bankAccounts: { id: string; name: string; number: string | null; balance: number }[];
  weeks: WeekRow[];
  totalInflows: number;
  totalOutflows: number;
  netChange: number;
  projectedEnd: number;
  lowestCash: number;
  lowestWeek: string;
  burnRate: number;
  runwayWeeks: number | null;
  runwayStatus: "healthy" | "caution" | "critical";
  deferredBeyondHorizon: number;
  /** Global avg collect / pay days (forecast-model fallbacks). */
  dso: number;
  dpo: number;
  /** Open AR / AP totals and coverage ratio: (cash + AR) / AP. */
  arOutstanding: number;
  apOutstanding: number;
  arCoverage: number | null;
  /** Configured recurring forecast flows, per-week — powers the drill + config. */
  categories: CategoryWeekly[];
  apSettings: ApSettings;
  /** Vendors with open AP or payment history — the category editor's picker. */
  vendorOptions: { id: string; name: string }[];
  /** All postable accounts with their type — the editor filters GL / card / bank. */
  accountOptions: { id: string; number: string | null; name: string; type: string }[];
}

/**
 * Whole-company liquidity for the Banking cash page — bank balances rolled
 * forward through the shared timeline, with runway / lowest-point vitals.
 * Shares every primitive with the analytics forecast; this view is the
 * operational read (act on cash), analytics is the analytical read (explain it).
 */
export async function cashPosition(
  orgId: string,
  horizonWeeks: number,
  apSettings: ApSettings,
  asOfDate?: string,
  /** Active subsidiary view (subtree ids) — scopes cash, open items, and
   * SQL-backed forecast categories. Omitted = whole company, unchanged SQL. */
  subIds?: string[],
): Promise<CashPosition> {
  const asOfIso = resolveAsOf(asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);

  const [arItems, apItems, arStats, apStats, banks, catConfigs, accountRows, vendorRows] = await Promise.all([
    openItems(orgId, "ar", asOfIso, subIds),
    openItems(orgId, "ap", asOfIso, subIds),
    paymentStats("ar", asOfIso),
    paymentStats("ap", asOfIso),
    bankBalances(asOfIso, subIds),
    loadCategories(orgId),
    db.execute(sql`
      select id, number, name, type from accounts
      where org_id = ${orgId} and is_summary = false
      order by number nulls last, name
    `) as Promise<any>,
    // "Parties with any payable document" is a semi-join: joining every
    // payable document to its party and then DISTINCTing back down to a few
    // thousand names materialized the whole document set to answer a
    // yes/no question per party.
    db.execute(sql`
      select p.id, p.display_name as name
      from parties p
      where p.org_id = ${orgId}
        and exists (
          select 1 from documents d
           where d.org_id = ${orgId} and d.party_id = p.id and d.voided_at is null
             and d.kind in ('vendor_bill', 'vendor_payment', 'check', 'expense_report')
        )
      order by 2
    `) as Promise<any>,
  ]);

  const startingCash = banks.reduce((a, b) => a + b.balance, 0);
  const arOutstanding = arItems.reduce((a, i) => a + i.remaining, 0);
  const apOutstanding = apItems.reduce((a, i) => a + i.remaining, 0);
  const ar = scheduleForecast(arItems, arStats, grid.asOf, grid.start, grid.end);
  const ap = scheduleForecast(apItems, apStats, grid.asOf, grid.start, grid.end);
  const weekTotals = (byWeek: Map<string, { amount: number }[]>): Record<string, number> =>
    Object.fromEntries([...byWeek.entries()].map(([k, es]) => [k, es.reduce((a, e) => a + e.amount, 0)]));
  const catContext = { arWeekly: weekTotals(ar.byWeek), apWeekly: weekTotals(ap.byWeek), cashStart: startingCash, subIds };
  const categories = await Promise.all(catConfigs.map((c) => categoryWeekly(orgId, c, asOfIso, grid.weekStarts, catContext)));
  const timeline = buildTimeline({
    weekStarts: grid.weekStarts,
    startingCash,
    arByWeek: ar.byWeek,
    apByWeek: ap.byWeek,
    categories,
    apSettings,
  });

  let lowestCash = startingCash;
  let lowestWeek = toISO(grid.start);
  for (const w of timeline.weeks) {
    if (w.endingCash < lowestCash) {
      lowestCash = w.endingCash;
      lowestWeek = w.weekStart;
    }
  }
  const n = timeline.weeks.length;
  const burnRate = n ? timeline.totalOutflows / n : 0;
  const netBurn = burnRate - (n ? timeline.totalInflows / n : 0);
  const runwayWeeks = netBurn > 0 && startingCash > 0 ? startingCash / netBurn : startingCash > 0 ? null : 0;
  const runwayStatus: CashPosition["runwayStatus"] =
    lowestCash < 0 ? "critical" : runwayWeeks !== null && runwayWeeks < 8 ? "caution" : "healthy";
  const projectedEnd = timeline.weeks.length ? timeline.weeks[timeline.weeks.length - 1]!.endingCash : startingCash;

  return {
    asOf: asOfIso,
    horizonWeeks,
    startingCash,
    bankAccounts: banks,
    weeks: timeline.weeks,
    totalInflows: timeline.totalInflows,
    totalOutflows: timeline.totalOutflows,
    netChange: timeline.totalInflows - timeline.totalOutflows,
    projectedEnd,
    lowestCash,
    lowestWeek,
    burnRate,
    runwayWeeks,
    runwayStatus,
    deferredBeyondHorizon: timeline.deferredBeyondHorizon,
    dso: arStats.globalAvg,
    dpo: apStats.globalAvg,
    arOutstanding,
    apOutstanding,
    // Coverage formula: (starting cash + AR outstanding) / AP outstanding.
    arCoverage: apOutstanding > 0 ? (startingCash + arOutstanding) / apOutstanding : null,
    categories,
    apSettings,
    vendorOptions: (vendorRows.rows as any[]).map((v) => ({ id: v.id, name: v.name })),
    accountOptions: (accountRows.rows as any[]).map((a) => ({ id: a.id, number: a.number ?? null, name: a.name, type: a.type })),
  };
}
