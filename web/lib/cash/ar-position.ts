import "server-only";
import {
  addDays,
  buildWeekGrid,
  daysBetween,
  openItems,
  paymentStats,
  resolveAsOf,
  scheduleForecast,
  summariseSide,
  toISO,
  weekLabel,
  parseISO,
  type ForecastEntry,
  type OpenItem,
  type SideSummary,
} from "./core";

export interface ArWeek {
  weekStart: string;
  weekEnd: string;
  label: string;
  amount: number;
  count: number;
  entries: ForecastEntry[];
}

export interface CustomerReceivable {
  partyId: string | null;
  partyName: string;
  amount: number;
  count: number;
  overdue: number;
  oldestDue: string | null;
}

export interface ArPosition {
  asOf: string;
  horizonWeeks: number;
  outstanding: number;
  overdue: number;
  overdueCount: number;
  /** Predicted to be collected in the first horizon week. */
  expectedThisWeek: number;
  /** Predicted to be collected within 30 days. */
  expectedNext30: number;
  dso: number;
  summary: SideSummary;
  weeks: ArWeek[];
  byCustomer: CustomerReceivable[];
  /** Collections worklist — most overdue / largest first. */
  worklist: ForecastEntry[];
}

function groupByCustomer(items: OpenItem[], asOf: Date): CustomerReceivable[] {
  const map = new Map<string, CustomerReceivable>();
  for (const it of items) {
    const key = it.partyId ?? "__none__";
    const cur =
      map.get(key) ??
      { partyId: it.partyId, partyName: it.partyName, amount: 0, count: 0, overdue: 0, oldestDue: null as string | null };
    cur.amount += it.remaining;
    cur.count += 1;
    if (it.dueDate && daysBetween(it.dueDate, asOf) > 0) cur.overdue += it.remaining;
    if (it.dueDate) {
      const iso = toISO(it.dueDate);
      if (!cur.oldestDue || iso < cur.oldestDue) cur.oldestDue = iso;
    }
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * Accounts-Receivable operational position — the AR cockpit's data source.
 * Open receivables, aging, predicted collection schedule and a collections
 * worklist, all off the shared cash engine so it agrees with the analytics
 * forecast and the AP cockpit to the penny.
 */
export async function arPosition(
  orgId: string,
  horizonWeeks: number,
  asOfDate?: string,
): Promise<ArPosition> {
  const asOfIso = resolveAsOf(asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);

  const [arItems, arStats] = await Promise.all([
    openItems("ar", asOfIso),
    paymentStats("ar", asOfIso),
  ]);

  const ar = scheduleForecast(arItems, arStats, grid.asOf, grid.start, grid.end);
  const summary = summariseSide(arItems, grid.asOf, ar.scheduled, arStats.globalAvg);
  const current = summary.buckets.find((b) => b.label === "Current")?.amount ?? 0;
  const overdue = Math.max(0, summary.outstanding - current);
  const overdueCount = arItems.filter((it) => it.dueDate && daysBetween(it.dueDate, grid.asOf) > 0).length;

  const weeks: ArWeek[] = grid.weekStarts.map((k) => {
    const entries = (ar.byWeek.get(k) ?? []).slice().sort((a, b) => b.amount - a.amount);
    const cur = parseISO(k);
    return {
      weekStart: k,
      weekEnd: toISO(addDays(cur, 6)),
      label: `${weekLabel(cur)} – ${weekLabel(addDays(cur, 6))}`,
      amount: entries.reduce((a, e) => a + e.amount, 0),
      count: entries.length,
      entries,
    };
  });

  const expectedThisWeek = weeks[0]?.amount ?? 0;
  const cutoff30 = toISO(addDays(grid.asOf, 30));
  const expectedNext30 = ar.entries.filter((e) => e.predictedDate <= cutoff30).reduce((a, e) => a + e.amount, 0);

  // Collections worklist: most overdue first, then largest.
  const worklist = ar.entries
    .slice()
    .sort((a, b) => {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return b.amount - a.amount;
    })
    .slice(0, 12);

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
  };
}
