import "server-only";
import {
  addDays,
  addMoney,
  bankBalances,
  buildWeekGrid,
  cashflowModel,
  chaseableEntries,
  collectionsBalances,
  forecastCategoryOrUnavailable,
  compareMoney,
  daysBetween,
  isUnappliedCredit,
  loadCategories,
  openItems,
  sumMoney,
  paymentStats,
  resolveAsOf,
  scheduleForecast,
  summariseSide,
  toISO,
  ZERO_MONEY,
  refusedCategories,
  type CategoryWeekly,
  type ForecastEntry,
  type NotForecastEntry,
  type OpenItem,
  type RefusedCategory,
  type SideSummary,
  type WeekRow,
} from "./core";
import { buildTimeline, type ApSettings } from "./cash-position";
import { agingBasisDate } from "../aging-basis";
import { isCategoryVisibleInScope } from "./core";
import { defaultFiscalCalendarPeriods, fiscalStartMonth } from "../fiscal";

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
  /** Net open receivables: invoices less unapplied credits. */
  outstanding: string;
  /** Gross past-due receivables; unapplied credits are excluded. */
  overdue: string;
  overdueCount: number;
  /** Unapplied customer credits as a positive magnitude; never overdue or chaseable. */
  unappliedCredits: { count: number; total: string };
  /** Predicted to be collected in the first horizon week. */
  expectedThisWeek: string;
  /** Predicted to be collected within 30 days. */
  expectedNext30: string;
  /** Mean days to settle behind the forecast (null = no payment history). */
  dso: number | null;
  summary: SideSummary;
  weeks: ArWeek[];
  byCustomer: CustomerReceivable[];
  /**
   * Collections worklist — every scheduled receivable in the horizon, most
   * overdue first then largest. The cockpit pre-checks the overdue ones.
   */
  worklist: ForecastEntry[];
  /**
   * Receivables past the collectability horizon. They are not projected as
   * receipts in any week or in expectedThisWeek / expectedNext30; they stay in
   * the aging figures and are listed here, most overdue first.
   */
  notForecast: {
    horizonDays: number;
    count: number;
    total: string;
    entries: NotForecastEntry[];
  };
  /** Recurring category flows per week — feeds the schedule drill's chips. */
  categories: CategoryWeekly[];
  /**
   * Categories that refused to forecast (they read as zeros above) — the
   * cockpit names them instead of presenting a healthy figure.
   */
  unavailableCategories: RefusedCategory[];
  /** Full shared-engine weekly rows — the per-week transaction drill. */
  timeline: WeekRow[];
}

/**
 * Per-customer rollup shared by the AR cockpit and the dashboard
 * top-customers list — one grouping so the two surfaces cannot disagree on
 * who owes what. Sorted largest balance first.
 */
export function groupByCustomer(items: OpenItem[], asOf: Date): CustomerReceivable[] {
  const map = new Map<string, CustomerReceivable>();
  for (const it of items) {
    const key = it.partyId ?? "__none__";
    const cur = map.get(key) ?? {
      partyId: it.partyId,
      partyName: it.partyName,
      amount: ZERO_MONEY,
      count: 0,
      overdue: ZERO_MONEY,
      oldestDue: null as string | null,
    };
    cur.amount = addMoney(cur.amount, it.remaining);
    cur.count += 1;
    // An unapplied credit nets into the customer's open balance above, but it
    // is not owed money: it is never past due and never sets the oldest date.
    if (!isUnappliedCredit(it)) {
      // Past-due follows the shared aging rule: an item with no due date ages
      // from its posting date, exactly like the overdue tiles — the customer
      // lines and the tiles cannot disagree on what "past due" means.
      const basis = agingBasisDate({ dueDate: it.dueDate, postingDate: it.tranDate });
      if (basis && daysBetween(basis, asOf) > 0) cur.overdue = addMoney(cur.overdue, it.remaining);
      // The oldest date the customer has owed money — the aging basis, not
      // the due date alone, so an overdue untermed line sets it instead of
      // leaving overdue money with a null oldest date.
      if (basis) {
        const iso = toISO(basis);
        if (!cur.oldestDue || iso < cur.oldestDue) cur.oldestDue = iso;
      }
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
  /**
   * Viewer BCP-47 locale for week labels (F2-14b); defaults to en-US like
   * the apPosition reader. UI readers pass the request locale —
   * the default serves the engine tests and label-agnostic agent callers.
   */
  locale = "en-US",
): Promise<ArPosition> {
  const subIds = allowedSubsidiaryIds === null ? undefined : [...allowedSubsidiaryIds];
  const asOfIso = await resolveAsOf(orgId, asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);

  const [
    arItems,
    apItems,
    arStats,
    apStats,
    banks,
    catConfigs,
    model,
    fiscalStart,
    fiscalCalendar,
  ] = await Promise.all([
    openItems(orgId, "ar", asOfIso, subIds),
    openItems(orgId, "ap", asOfIso, subIds),
    paymentStats("ar", asOfIso, subIds, orgId),
    paymentStats("ap", asOfIso, subIds, orgId),
    bankBalances(asOfIso, subIds, orgId),
    loadCategories(orgId),
    cashflowModel(orgId),
    fiscalStartMonth(orgId),
    defaultFiscalCalendarPeriods(orgId),
  ]);

  const startingCash = sumMoney(banks.map((b) => b.balance));
  const ar = scheduleForecast(arItems, arStats, grid.asOf, grid.start, grid.end, model, true);
  const ap = scheduleForecast(apItems, apStats, grid.asOf, grid.start, grid.end, model);
  const weekTotals = (byWeek: Map<string, { amount: string }[]>): Record<string, string> =>
    Object.fromEntries(
      [...byWeek.entries()].map(([k, es]) => [k, sumMoney(es.map((e) => e.amount))]),
    );
  const catContext = {
    arWeekly: weekTotals(ar.byWeek),
    apWeekly: weekTotals(ap.byWeek),
    cashStart: startingCash,
    model,
    subIds,
    fiscalStartMonth: fiscalStart,
    fiscalPeriods: fiscalCalendar?.periods ?? null,
  };
  const visibleConfigs = catConfigs.filter((c) =>
    isCategoryVisibleInScope(c, subIds, allowedSubsidiaryIds),
  );
  // A refusing category contributes zeros and names its reason; the rest of
  // the forecast still renders. Anything else still throws.
  const categories = await Promise.all(
    visibleConfigs.map((c) =>
      forecastCategoryOrUnavailable(orgId, c, asOfIso, grid.weekStarts, catContext, locale),
    ),
  );
  const timeline = buildTimeline({
    weekStarts: grid.weekStarts,
    startingCash,
    arByWeek: ar.byWeek,
    apByWeek: ap.byWeek,
    categories,
    apSettings,
    locale,
  });

  const summary = summariseSide(arItems, grid.asOf, ar.scheduled, arStats.globalAvg, ar.unplaced);
  // Overdue is the gross past-due receivable balance. The aging buckets above
  // stay net of unapplied credits, so they reconcile to the aging report;
  // the collections figures never let a credit read as an overdue receivable.
  const balances = collectionsBalances(arItems, grid.asOf);

  const weeks: ArWeek[] = grid.weekStarts.map((k, i) => {
    const entries = (ar.byWeek.get(k) ?? [])
      .slice()
      .sort((a, b) => compareMoney(b.amount, a.amount));
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
  // The dashboard tile reads the same +30d cut-off off the same items: the
  // weekly grid can end short of it, so a cut-off-bounded schedule feeds
  // this figure instead of the grid-bounded entries (placement is
  // end-independent — widening the bound only adds days 29–30).
  const cutoffSchedule = scheduleForecast(
    arItems,
    arStats,
    grid.asOf,
    grid.start,
    addDays(grid.asOf, 30),
    model,
    true,
  );
  const expectedNext30 = sumMoney(
    cutoffSchedule.entries.filter((e) => e.predictedDate <= cutoff30).map((e) => e.amount),
  );

  // Collections worklist: receivables only, most overdue first, then largest.
  const worklist = chaseableEntries(ar.entries)
    .slice()
    .sort((a, b) => {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return compareMoney(b.amount, a.amount);
    });

  return {
    asOf: asOfIso,
    horizonWeeks,
    outstanding: summary.outstanding,
    overdue: balances.overdue,
    overdueCount: balances.overdueCount,
    unappliedCredits: { count: balances.unappliedCreditCount, total: balances.unappliedCredits },
    expectedThisWeek,
    expectedNext30,
    dso: arStats.globalAvg,
    summary,
    weeks,
    byCustomer: groupByCustomer(arItems, grid.asOf),
    worklist,
    notForecast: {
      horizonDays: model.collectibilityHorizonDays,
      count: ar.notForecast.count,
      total: ar.notForecast.total,
      entries: ar.notForecast.entries,
    },
    categories,
    unavailableCategories: refusedCategories(categories),
    timeline: timeline.weeks,
  };
}
