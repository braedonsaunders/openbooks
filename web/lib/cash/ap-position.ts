import "server-only";
import {
  addDays,
  addMoney,
  bankBalances,
  buildWeekGrid,
  cashflowModel,
  forecastCategoryOrUnavailable,
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
import { isCategoryVisibleInScope } from "./core";
import { agingBasisDate } from "../aging-basis";
import { fiscalStartMonth } from "../fiscal";

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
  /** Mean days to settle behind the forecast (null = no payment history). */
  dpo: number | null;
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

/**
 * Per-vendor rollup shared by the AP cockpit and the dashboard top-vendors
 * list — one grouping so the two surfaces cannot disagree on who is owed
 * what. Sorted largest balance first.
 */
export function groupByVendor(items: OpenItem[], asOf: Date): VendorPayable[] {
  const map = new Map<string, VendorPayable>();
  for (const it of items) {
    const key = it.partyId ?? "__none__";
    const cur =
      map.get(key) ??
      { partyId: it.partyId, partyName: it.partyName, amount: ZERO_MONEY, count: 0, overdue: ZERO_MONEY, oldestDue: null as string | null };
    cur.amount = addMoney(cur.amount, it.remaining);
    cur.count += 1;
    // Past-due follows the shared aging rule: an item with no due date ages
    // from its posting date, exactly like the overdue tiles — the vendor
    // lines and the tiles cannot disagree on what "past due" means.
    const basis = agingBasisDate({ dueDate: it.dueDate, postingDate: it.tranDate });
    if (basis && daysBetween(basis, asOf) > 0) cur.overdue = addMoney(cur.overdue, it.remaining);
    // The oldest date owed — the aging basis, not the due date alone, so
    // an overdue untermed line sets it instead of leaving overdue money
    // with a null oldest date.
    if (basis) {
      const iso = toISO(basis);
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
  asOfDate: string | undefined,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  /** BCP-47 locale for week labels; defaults to en-US. */
  locale = "en-US",
): Promise<ApPosition> {
  const subIds = allowedSubsidiaryIds === null ? undefined : [...allowedSubsidiaryIds];
  const asOfIso = await resolveAsOf(orgId, asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);
  const exactApSettings: ApSettings = { ...apSettings, weeklyCap: normalizeMoneyValue(String(apSettings.weeklyCap)) };

  const [apItems, arItems, apStats, arStats, banks, catConfigs, model, fiscalStart] = await Promise.all([
    openItems(orgId, "ap", asOfIso, subIds),
    openItems(orgId, "ar", asOfIso, subIds),
    paymentStats("ap", asOfIso, subIds, orgId),
    paymentStats("ar", asOfIso, subIds, orgId),
    bankBalances(asOfIso, subIds, orgId),
    loadCategories(orgId),
    cashflowModel(orgId),
    fiscalStartMonth(orgId),
  ]);

  const startingCash = sumMoney(banks.map((b) => b.balance));
  const ap = scheduleForecast(apItems, apStats, grid.asOf, grid.start, grid.end, model);
  const ar = scheduleForecast(arItems, arStats, grid.asOf, grid.start, grid.end, model);
  const weekTotals = (byWeek: Map<string, { amount: string }[]>): Record<string, string> =>
    Object.fromEntries([...byWeek.entries()].map(([k, es]) => [k, sumMoney(es.map((e) => e.amount))]));
  const catContext = { arWeekly: weekTotals(ar.byWeek), apWeekly: weekTotals(ap.byWeek), cashStart: startingCash, model, subIds, fiscalStartMonth: fiscalStart };
  const visibleConfigs = catConfigs.filter((c) => isCategoryVisibleInScope(c, subIds, allowedSubsidiaryIds));
  // A refusing category contributes zeros and names its reason; the rest of
  // the forecast still renders. Anything else still throws.
  const categories = await Promise.all(visibleConfigs.map((c) => forecastCategoryOrUnavailable(orgId, c, asOfIso, grid.weekStarts, catContext, locale)));
  const timeline = buildTimeline({
    weekStarts: grid.weekStarts,
    startingCash,
    arByWeek: ar.byWeek,
    apByWeek: ap.byWeek,
    categories,
    apSettings: exactApSettings,
    locale,
  });

  const summary = summariseSide(apItems, grid.asOf, ap.scheduled, apStats.globalAvg, ap.unplaced);
  const current = summary.buckets.find((b) => b.index === 0)?.amount ?? ZERO_MONEY;
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
