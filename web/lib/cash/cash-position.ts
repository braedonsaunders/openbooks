import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import {
  addDays,
  addMoney,
  compareMoney,
  divideMoney,
  bankBalances,
  buildWeekGrid,
  categoryWeekly,
  loadCategories,
  openItems,
  normalizeMoneyValue,
  parseISO,
  paymentStats,
  resolveAsOf,
  scheduleForecast,
  subtractMoney,
  sumMoney,
  toISO,
  ZERO_MONEY,
  weekLabel,
  type CategoryWeekly,
  type ForecastEntry,
  type WeekRow,
} from "./core";

/** AP capacity-scheduling knobs (the cashflow config). */
export interface ApSettings {
  weeklyCap: string;
  restrictToSafe: boolean;
}

export interface TimelineResult {
  weeks: WeekRow[];
  totalInflows: string;
  totalOutflows: string;
  /** AP predicted inside the horizon but unpayable under the cap — spills past the end. */
  deferredBeyondHorizon: string;
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
  startingCash: string;
  arByWeek: Map<string, ForecastEntry[]>;
  apByWeek: Map<string, ForecastEntry[]>;
  categories: CategoryWeekly[];
  apSettings: ApSettings;
}): TimelineResult {
  const { weekStarts, startingCash, arByWeek, apByWeek, categories, apSettings } = args;
  const weeklyCap = normalizeMoneyValue(apSettings.weeklyCap);
  const schedulingOn = compareMoney(weeklyCap, ZERO_MONEY) > 0 || apSettings.restrictToSafe;

  const weeks: WeekRow[] = [];
  const exactStartingCash = normalizeMoneyValue(startingCash);
  let running = exactStartingCash;
  let totalIn = ZERO_MONEY;
  let totalOut = ZERO_MONEY;
  let backlog: ForecastEntry[] = [];
  weekStarts.forEach((k, wi) => {
    const cur = parseISO(k);
    const arEntries = (arByWeek.get(k) ?? []).sort((a, b) => compareMoney(b.amount, a.amount));
    const dueThisWeek = apByWeek.get(k) ?? [];
    const dynamicInflow = sumMoney(categories.filter((c) => c.direction === "inflow").map((c) => c.weekly[wi] ?? ZERO_MONEY));
    const dynamicOutflow = sumMoney(categories.filter((c) => c.direction === "outflow").map((c) => c.weekly[wi] ?? ZERO_MONEY));
    const arInflow = sumMoney(arEntries.map((e) => e.amount));

    let apEntries: ForecastEntry[];
    let deferredOut = ZERO_MONEY;
    let apCapacity: string | null = null;
    if (schedulingOn) {
      // Oldest due date first, then largest amount (the backlog order).
      backlog = [...backlog, ...dueThisWeek].sort((a, b) => {
        const ad = a.dueDate ?? a.predictedDate;
        const bd = b.dueDate ?? b.predictedDate;
        return ad < bd ? -1 : ad > bd ? 1 : compareMoney(b.amount, a.amount);
      });
      const safe = apSettings.restrictToSafe
        ? (() => {
            const available = subtractMoney(addMoney(addMoney(running, arInflow), dynamicInflow), dynamicOutflow);
            return compareMoney(available, ZERO_MONEY) > 0 ? available : ZERO_MONEY;
          })()
        : null;
      apCapacity = safe === null
        ? (compareMoney(weeklyCap, ZERO_MONEY) > 0 ? weeklyCap : null)
        : compareMoney(weeklyCap, ZERO_MONEY) > 0 && compareMoney(weeklyCap, safe) < 0 ? weeklyCap : safe;
      const paid: ForecastEntry[] = [];
      let spent = ZERO_MONEY;
      const remaining: ForecastEntry[] = [];
      for (const e of backlog) {
        if (apCapacity === null || compareMoney(addMoney(spent, e.amount), apCapacity) <= 0) {
          spent = addMoney(spent, e.amount);
          paid.push(e.weekStart === k ? e : { ...e, weekStart: k, method: `${e.method} (deferred from ${e.weekStart})` });
        } else {
          remaining.push(e);
        }
      }
      backlog = remaining;
      deferredOut = sumMoney(remaining.map((e) => e.amount));
      apEntries = paid.sort((a, b) => compareMoney(b.amount, a.amount));
    } else {
      apEntries = dueThisWeek.sort((a, b) => compareMoney(b.amount, a.amount));
    }

    const apOutflow = sumMoney(apEntries.map((e) => e.amount));
    const inflow = addMoney(arInflow, dynamicInflow);
    const outflow = addMoney(apOutflow, dynamicOutflow);
    const net = subtractMoney(inflow, outflow);
    const startingWk = running;
    running = addMoney(running, net);
    totalIn = addMoney(totalIn, inflow);
    totalOut = addMoney(totalOut, outflow);
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
      apTotal: sumMoney(apEntries.map((e) => e.amount)),
      arCount: arEntries.length,
      apCount: apEntries.length,
      dynamicInflow,
      dynamicOutflow,
      deferredOut,
      apCapacity,
    });
  });
  const deferredBeyondHorizon = sumMoney(backlog.map((e) => e.amount));
  return { weeks, totalInflows: totalIn, totalOutflows: totalOut, deferredBeyondHorizon };
}

export interface CashPosition {
  asOf: string;
  horizonWeeks: number;
  startingCash: string;
  bankAccounts: { id: string; name: string; number: string | null; balance: string }[];
  weeks: WeekRow[];
  totalInflows: string;
  totalOutflows: string;
  netChange: string;
  projectedEnd: string;
  lowestCash: string;
  lowestWeek: string;
  burnRate: string;
  runwayWeeks: string | null;
  runwayStatus: "healthy" | "caution" | "critical";
  deferredBeyondHorizon: string;
  /** Global avg collect / pay days (forecast-model fallbacks). */
  dso: number;
  dpo: number;
  /** Open AR / AP totals and coverage ratio: (cash + AR) / AP. */
  arOutstanding: string;
  apOutstanding: string;
  arCoverage: string | null;
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
  asOfDate: string | undefined,
  /** Active subsidiary view (subtree ids) — scopes cash, open items, and
   * SQL-backed categories. Omission inherits the caller's full allowed set. */
  requestedSubIds: string[] | undefined,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<CashPosition> {
  const subIds = allowedSubsidiaryIds === null ? requestedSubIds
    : requestedSubIds === undefined ? [...allowedSubsidiaryIds]
    : requestedSubIds.filter(id => allowedSubsidiaryIds.has(id));
  const visible = subIds === undefined ? null : new Set(subIds);
  const asOfIso = await resolveAsOf(orgId, asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);

  const [arItems, apItems, arStats, apStats, banks, catConfigs, accountRows, vendorRows] = await Promise.all([
    openItems(orgId, "ar", asOfIso, subIds),
    openItems(orgId, "ap", asOfIso, subIds),
    paymentStats("ar", asOfIso, subIds),
    paymentStats("ap", asOfIso, subIds),
    bankBalances(asOfIso, subIds),
    loadCategories(orgId),
    db.execute(sql`
      select id, number, name, type from accounts
      where org_id = ${orgId} and is_summary = false
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, visible, { orgWideNull: true })}
      order by number nulls last, name
    `),
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
             ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, visible)}
        )
      order by 2
    `),
  ]);

  const startingCash = sumMoney(banks.map((b) => b.balance));
  const arOutstanding = sumMoney(arItems.map((i) => i.remaining));
  const apOutstanding = sumMoney(apItems.map((i) => i.remaining));
  const ar = scheduleForecast(arItems, arStats, grid.asOf, grid.start, grid.end);
  const ap = scheduleForecast(apItems, apStats, grid.asOf, grid.start, grid.end);
  const weekTotals = (byWeek: Map<string, { amount: string }[]>): Record<string, string> =>
    Object.fromEntries([...byWeek.entries()].map(([k, es]) => [k, sumMoney(es.map((e) => e.amount))]));
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
    if (compareMoney(w.endingCash, lowestCash) < 0) {
      lowestCash = w.endingCash;
      lowestWeek = w.weekStart;
    }
  }
  const n = timeline.weeks.length;
  const burnRate = n ? divideMoney(timeline.totalOutflows, String(n)) : ZERO_MONEY;
  const netBurn = subtractMoney(burnRate, n ? divideMoney(timeline.totalInflows, String(n)) : ZERO_MONEY);
  const runwayWeeks = compareMoney(netBurn, ZERO_MONEY) > 0 && compareMoney(startingCash, ZERO_MONEY) > 0 ? divideMoney(startingCash, netBurn) : compareMoney(startingCash, ZERO_MONEY) > 0 ? null : ZERO_MONEY;
  const runwayStatus: CashPosition["runwayStatus"] =
    compareMoney(lowestCash, ZERO_MONEY) < 0 ? "critical" : runwayWeeks !== null && compareMoney(runwayWeeks, "8.0000") < 0 ? "caution" : "healthy";
  const projectedEnd = timeline.weeks.length ? timeline.weeks[timeline.weeks.length - 1]!.endingCash : startingCash;

  return {
    asOf: asOfIso,
    horizonWeeks,
    startingCash,
    bankAccounts: banks,
    weeks: timeline.weeks,
    totalInflows: timeline.totalInflows,
    totalOutflows: timeline.totalOutflows,
    netChange: subtractMoney(timeline.totalInflows, timeline.totalOutflows),
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
    arCoverage: compareMoney(apOutstanding, ZERO_MONEY) > 0 ? divideMoney(addMoney(startingCash, arOutstanding), apOutstanding) : null,
    categories,
    apSettings: { ...apSettings, weeklyCap: normalizeMoneyValue(apSettings.weeklyCap) },
    vendorOptions: (vendorRows.rows as any[]).map((v) => ({ id: v.id, name: v.name })),
    accountOptions: (accountRows.rows as any[]).map((a) => ({ id: a.id, number: a.number ?? null, name: a.name, type: a.type })),
  };
}
