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
  openItems,
  sumMoney,
  paymentStats,
  resolveAsOf,
  scheduleForecast,
  summariseSide,
  subtractMoney,
  toISO,
  ZERO_MONEY,
  type CategoryWeekly,
  type ForecastEntry,
  type OpenItem,
  type SideSummary,
  type WeekRow,
} from "./core";
import { buildTimeline, type ApSettings } from "./cash-position";

export interface ArWeek {
  weekStart: string;
  weekEnd: string;
  label: string;
  amount: string;
  count: number;
  entries: ForecastEntry[];
}

export interface CustomerReceivable {
  partyId: string | null;
  partyName: string;
  amount: string;
  count: number;
  overdue: string;
  oldestDue: string | null;
}

export interface ArPosition {
  asOf: string;
  horizonWeeks: number;
  outstanding: string;
  overdue: string;
  overdueCount: number;
  /** Predicted to be collected in the first horizon week. */
  expectedThisWeek: string;
  /** Predicted to be collected within 30 days. */
  expectedNext30: string;
  dso: number;
  summary: SideSummary;
  weeks: ArWeek[];
  byCustomer: CustomerReceivable[];
  /**
   * Collections worklist — every scheduled receivable in the horizon, most
   * overdue first then largest. The cockpit pre-checks the overdue ones.
   */
  worklist: ForecastEntry[];
  /** Recurring category flows per week — feeds the schedule drill's chips. */
  categories: CategoryWeekly[];
  /** Full shared-engine weekly rows — the per-week transaction drill. */
  timeline: WeekRow[];
}

function groupByCustomer(items: OpenItem[], asOf: Date): CustomerReceivable[] {
  const map = new Map<string, CustomerReceivable>();
  for (const it of items) {
    const key = it.partyId ?? "__none__";
    const cur =
      map.get(key) ??
      { partyId: it.partyId, partyName: it.partyName, amount: ZERO_MONEY, count: 0, overdue: ZERO_MONEY, oldestDue: null as string | null };
    cur.amount = addMoney(cur.amount, it.remaining);
    cur.count += 1;
    if (it.dueDate && daysBetween(it.dueDate, asOf) > 0) cur.overdue = addMoney(cur.overdue, it.remaining);
    if (it.dueDate) {
      const iso = toISO(it.dueDate);
      if (!cur.oldestDue || iso < cur.oldestDue) cur.oldestDue = iso;
    }
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => compareMoney(b.amount, a.amount));
}

/**
 * Accounts-Receivable operational position — the AR cockpit's data source.
 * Open receivables, aging, predicted collection schedule, the collections
 * worklist, and the full shared weekly timeline (for the per-week drill), all
 * off the shared cash engine so it agrees with the analytics forecast and the
 * AP cockpit to the penny.
 */
export async function arPosition(
  orgId: string,
  horizonWeeks: number,
  apSettings: ApSettings,
  asOfDate: string | undefined,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ArPosition> {
  const subIds = allowedSubsidiaryIds === null ? undefined : [...allowedSubsidiaryIds];
  const asOfIso = await resolveAsOf(orgId, asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);

  const [arItems, apItems, arStats, apStats, banks, catConfigs] = await Promise.all([
    openItems(orgId, "ar", asOfIso, subIds),
    openItems(orgId, "ap", asOfIso, subIds),
    paymentStats("ar", asOfIso, subIds),
    paymentStats("ap", asOfIso, subIds),
    bankBalances(asOfIso, subIds),
    loadCategories(orgId),
  ]);

  const startingCash = sumMoney(banks.map((b) => b.balance));
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

  const summary = summariseSide(arItems, grid.asOf, ar.scheduled, arStats.globalAvg);
  const current = summary.buckets.find((b) => b.label === "Current")?.amount ?? ZERO_MONEY;
  const overdue = compareMoney(summary.outstanding, current) > 0 ? subtractMoney(summary.outstanding, current) : ZERO_MONEY;
  const overdueCount = arItems.filter((it) => it.dueDate && daysBetween(it.dueDate, grid.asOf) > 0).length;

  const weeks: ArWeek[] = grid.weekStarts.map((k, i) => {
    const entries = (ar.byWeek.get(k) ?? []).slice().sort((a, b) => compareMoney(b.amount, a.amount));
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

  const expectedThisWeek = weeks[0]?.amount ?? ZERO_MONEY;
  const cutoff30 = toISO(addDays(grid.asOf, 30));
  const expectedNext30 = sumMoney(ar.entries.filter((e) => e.predictedDate <= cutoff30).map((e) => e.amount));

  // Collections worklist: most overdue first, then largest.
  const worklist = ar.entries
    .slice()
    .sort((a, b) => {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return compareMoney(b.amount, a.amount);
    });

  return {
    asOf: asOfIso,
    horizonWeeks,
    outstanding: summary.outstanding,
    overdue,
    overdueCount,
    expectedThisWeek,
    expectedNext30,
    dso: arStats.globalAvg,
    summary,
    weeks,
    byCustomer: groupByCustomer(arItems, grid.asOf),
    worklist,
    categories,
    timeline: timeline.weeks,
  };
}
