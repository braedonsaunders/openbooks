import "server-only";
import {
  addDays,
  addMoney,
  bankBalances,
  buildWeekGrid,
  categoryWeekly,
  compareMoney,
  daysBetween,
  loadCategories,
  normalizeMoneyValue,
  openItems,
  paymentStats,
  resolveAsOf,
  scheduleForecast,
  summariseSide,
  subtractMoney,
  sumMoney,
  toISO,
  ZERO_MONEY,
  type CategoryWeekly,
  type ForecastEntry,
  type OpenItem,
  type SideSummary,
  type WeekRow,
} from "./core";
import { buildTimeline, type ApSettings } from "./cash-position";

export interface ApWeek {
  weekStart: string;
  weekEnd: string;
  label: string;
  amount: string;
  count: number;
  entries: ForecastEntry[];
}

export interface VendorPayable {
  partyId: string | null;
  partyName: string;
  amount: string;
  count: number;
  overdue: string;
  oldestDue: string | null;
}

/**
 * The capacity-scheduled recommendation for the FIRST horizon week — the
 * pay-run planner's core. `recommended` are the payables that clear this week's
 * cap (oldest-due first); the rest defers. When no cap/safe limit is set the
 * recommendation is simply everything predicted due this week.
 */
export interface PayRunPlan {
  weeklyCap: string;
  restrictToSafe: boolean;
  scheduling: boolean;
  capacity: string | null;
  startingCash: string;
  recommended: ForecastEntry[];
  recommendedTotal: string;
  deferredThisWeek: string;
  deferredBeyondHorizon: string;
}

export interface ApPosition {
  asOf: string;
  horizonWeeks: number;
  /** Total open payables outstanding. */
  outstanding: string;
  overdue: string;
  overdueCount: number;
  /** Predicted to be paid in the first horizon week. */
  dueThisWeek: string;
  /** Predicted to be paid within 30 days. */
  dueNext30: string;
  dpo: number;
  summary: SideSummary;
  weeks: ApWeek[];
  byVendor: VendorPayable[];
  /** Pay-priority worklist (oldest due first), for the quick pay list. */
  worklist: ForecastEntry[];
  payPlan: PayRunPlan;
  /** Recurring category flows per week — feeds the schedule drill's chips. */
  categories: CategoryWeekly[];
  /** Full shared-engine weekly rows — the per-week transaction drill. */
  timeline: WeekRow[];
}

function groupByVendor(items: OpenItem[], asOf: Date): VendorPayable[] {
  const map = new Map<string, VendorPayable>();
  for (const it of items) {
    const key = it.partyId ?? "__none__";
    const cur =
      map.get(key) ??
      { partyId: it.partyId, partyName: it.partyName, amount: ZERO_MONEY, count: 0, overdue: ZERO_MONEY, oldestDue: null as string | null };
    cur.amount = addMoney(cur.amount, it.remaining);
    cur.count += 1;
    const overdue = it.dueDate ? daysBetween(it.dueDate, asOf) > 0 : false;
    if (overdue) cur.overdue = addMoney(cur.overdue, it.remaining);
    if (it.dueDate) {
      const iso = toISO(it.dueDate);
      if (!cur.oldestDue || iso < cur.oldestDue) cur.oldestDue = iso;
    }
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => compareMoney(b.amount, a.amount));
}

/**
 * Accounts-Payable operational position — the AP cockpit's data source. Open
 * payables, aging, predicted payment schedule and the capacity-scheduled
 * pay-run plan, all off the shared cash engine so the planner agrees with the
 * analytics forecast to the penny.
 */
export async function apPosition(
  orgId: string,
  horizonWeeks: number,
  apSettings: ApSettings,
  asOfDate?: string,
): Promise<ApPosition> {
  const asOfIso = await resolveAsOf(orgId, asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);
  const exactApSettings: ApSettings = { ...apSettings, weeklyCap: normalizeMoneyValue(String(apSettings.weeklyCap)) };

  const [apItems, arItems, apStats, arStats, banks, catConfigs] = await Promise.all([
    openItems(orgId, "ap", asOfIso),
    openItems(orgId, "ar", asOfIso),
    paymentStats("ap", asOfIso),
    paymentStats("ar", asOfIso),
    bankBalances(asOfIso),
    loadCategories(orgId),
  ]);

  const startingCash = sumMoney(banks.map((b) => b.balance));
  const ap = scheduleForecast(apItems, apStats, grid.asOf, grid.start, grid.end);
  const ar = scheduleForecast(arItems, arStats, grid.asOf, grid.start, grid.end);
  const weekTotals = (byWeek: Map<string, { amount: string }[]>): Record<string, string> =>
    Object.fromEntries([...byWeek.entries()].map(([k, es]) => [k, sumMoney(es.map((e) => e.amount))]));
  const catContext = { arWeekly: weekTotals(ar.byWeek), apWeekly: weekTotals(ap.byWeek), cashStart: startingCash };
  const categories = await Promise.all(catConfigs.map((c) => categoryWeekly(orgId, c, asOfIso, grid.weekStarts, catContext)));
  const timeline = buildTimeline({
    weekStarts: grid.weekStarts,
    startingCash,
    arByWeek: ar.byWeek,
    apByWeek: ap.byWeek,
    categories,
    apSettings: exactApSettings,
  });

  const summary = summariseSide(apItems, grid.asOf, ap.scheduled, apStats.globalAvg);
  const current = summary.buckets.find((b) => b.label === "Current")?.amount ?? ZERO_MONEY;
  const overdue = compareMoney(summary.outstanding, current) > 0 ? subtractMoney(summary.outstanding, current) : ZERO_MONEY;
  const overdueCount = apItems.filter((it) => it.dueDate && daysBetween(it.dueDate, grid.asOf) > 0).length;

  const weeks: ApWeek[] = grid.weekStarts.map((k, i) => {
    const entries = (ap.byWeek.get(k) ?? []).slice().sort((a, b) => compareMoney(b.amount, a.amount));
    const w = timeline.weeks[i]!;
    return {
      weekStart: k,
      weekEnd: w.weekEnd,
      label: w.label,
      amount: sumMoney(entries.map((e) => e.amount)),
      count: entries.length,
      entries,
    };
  });

  const dueThisWeek = weeks[0]?.amount ?? ZERO_MONEY;
  const cutoff30 = toISO(addDays(grid.asOf, 30));
  const dueNext30 = sumMoney(ap.entries.filter((e) => e.predictedDate <= cutoff30).map((e) => e.amount));

  // Pay-priority worklist: oldest due first, then most overdue, then largest.
  const worklist = ap.entries
    .slice()
    .sort((a, b) => {
      const ad = a.dueDate ?? a.predictedDate;
      const bd = b.dueDate ?? b.predictedDate;
      if (ad !== bd) return ad < bd ? -1 : 1;
      return compareMoney(b.amount, a.amount);
    })
    .slice(0, 12);

  const firstWeek = timeline.weeks[0];
  const scheduling = compareMoney(exactApSettings.weeklyCap, ZERO_MONEY) > 0 || exactApSettings.restrictToSafe;
  const recommended = firstWeek?.apEntries ?? [];
  const payPlan: PayRunPlan = {
    weeklyCap: exactApSettings.weeklyCap,
    restrictToSafe: exactApSettings.restrictToSafe,
    scheduling,
    capacity: firstWeek?.apCapacity ?? null,
    startingCash,
    recommended,
    recommendedTotal: sumMoney(recommended.map((e) => e.amount)),
    deferredThisWeek: firstWeek?.deferredOut ?? ZERO_MONEY,
    deferredBeyondHorizon: timeline.deferredBeyondHorizon,
  };

  return {
    asOf: asOfIso,
    horizonWeeks,
    outstanding: summary.outstanding,
    overdue,
    overdueCount,
    dueThisWeek,
    dueNext30,
    dpo: apStats.globalAvg,
    summary,
    weeks,
    byVendor: groupByVendor(apItems, grid.asOf),
    worklist,
    payPlan,
    categories,
    timeline: timeline.weeks,
  };
}
