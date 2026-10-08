import {
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
} from "../money/exact-decimal.ts";

/**
 * Earned-value arithmetic for project tasks — pure, exact, and deterministic.
 *
 * Every figure is an exact decimal string; nothing crosses JavaScript's
 * floating-point boundary. Rounding is explicit and happens once, at the end
 * of each derivation, halves away from zero:
 *
 *   money (BAC, EV, AC, ETC, EAC, variance, burn) .... 4 places
 *   quantities (budget, installed) ................... 8 places
 *   hours ............................................ 4 places
 *   percent complete (0–100) ......................... 4 places
 *   CPI and productivity ............................. 4 places
 *   weeks to complete ................................ 2 places
 *
 * Ratios with no denominator (no actual cost, no labor hours, no weekly burn)
 * are null — unmeasurable, never zero and never infinite.
 */

export const MONEY_SCALE = 4;
export const QUANTITY_SCALE = 8;
export const HOURS_SCALE = 4;
export const PERCENT_SCALE = 4;
export const RATIO_SCALE = 4;
export const WEEKS_SCALE = 2;
/** Burn rate looks back four whole weeks (28 days ending on the as-of date). */
export const BURN_WINDOW_WEEKS = 4;

export type PercentCompleteBasis = "quantity" | "schedule" | "cost" | "none";
export type ForecastMethod = "manual" | "remaining_budget" | "units_productivity" | "cost_performance";
export type EstimateSource = "forecast" | "remaining_budget";

export interface TaskForecastInput {
  method: ForecastMethod;
  asOfDate: string;
  costToComplete: string;
  hoursToComplete: string | null;
}

export interface TaskEarnedValueInput {
  taskId: string;
  code: string | null;
  name: string;
  /** Current cost budget (project_tasks.estimated_cost); null when unset. */
  budgetCost: string | null;
  budgetHours: string | null;
  budgetQuantity: string | null;
  budgetUnit: string | null;
  /** Net installed quantity on or before the as-of date. */
  installedQuantity: string;
  /** Manual schedule progress (0–1) when the task carries schedule dates. */
  scheduleProgress: string | null;
  actualCost: string;
  actualHours: string;
  /** Actual cost and hours inside the trailing burn window. */
  trailingCost: string;
  trailingHours: string;
  forecast: TaskForecastInput | null;
}

export interface TaskEarnedValue {
  taskId: string;
  code: string | null;
  name: string;
  basis: PercentCompleteBasis;
  /** 0–100, null when the basis is "none". */
  percentComplete: string | null;
  budgetAtCompletion: string;
  budgetQuantity: string | null;
  budgetUnit: string | null;
  installedQuantity: string;
  earnedValue: string;
  actualCost: string;
  costPerformanceIndex: string | null;
  estimateToComplete: string;
  estimateSource: EstimateSource;
  forecastMethod: ForecastMethod | null;
  forecastAsOf: string | null;
  estimateAtCompletion: string;
  varianceAtCompletion: string;
  budgetHours: string | null;
  actualHours: string;
  hoursToComplete: string | null;
  /** Installed units per labor hour; null without a quantity budget or hours. */
  productivity: string | null;
  weeklyCostBurn: string;
  weeklyHoursBurn: string;
  weeksToComplete: string | null;
}

/** Round an exact decimal of any scale to `scale` places, halves away from zero. */
export const roundDecimal = (value: string, scale: number): string => divideDecimal(value, "1", scale);
export const money = (value: string | null | undefined): string => roundDecimal(value ?? "0", MONEY_SCALE);
const quantity = (value: string | null | undefined): string => roundDecimal(value ?? "0", QUANTITY_SCALE);
const hours = (value: string | null | undefined): string => roundDecimal(value ?? "0", HOURS_SCALE);

export function addDecimal(left: string, right: string, scale: number): string {
  // The sum is exact at the wider input scale; only the result is rounded.
  return roundDecimal(sumUnscaled(left, right), scale);
}

function sumUnscaled(left: string, right: string): string {
  const scale = Math.max(fraction(left), fraction(right));
  const a = toUnits(left, scale);
  const b = toUnits(right, scale);
  return fromUnits(a + b, scale);
}

export function subtractDecimal(left: string, right: string, scale: number): string {
  return addDecimal(left, negate(right), scale);
}

function negate(value: string): string {
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

function fraction(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

function toUnits(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole, frac = ""] = value.replace(/^[+-]/, "").split(".");
  const units = BigInt(whole || "0") * 10n ** BigInt(scale) + BigInt((frac + "0".repeat(scale)).slice(0, scale) || "0");
  return negative ? -units : units;
}

function fromUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${negative ? "-" : ""}${body}`;
}

const positive = (value: string | null): value is string => value !== null && compareDecimal(value, "0") > 0;
const maxZero = (value: string, scale: number): string =>
  compareDecimal(value, "0") < 0 ? roundDecimal("0", scale) : roundDecimal(value, scale);

/** value × numerator ÷ denominator, rounded once at `scale`. Denominator must be positive. */
export function scaleBy(value: string, numerator: string, denominator: string, scale: number): string {
  const exactProduct = multiplyDecimal(value, numerator, fraction(value) + fraction(numerator));
  return divideDecimal(exactProduct, denominator, scale);
}

/** Clamp a completion ratio numerator into [0, denominator]. */
function clampToWhole(numerator: string, denominator: string): string {
  if (compareDecimal(numerator, "0") <= 0) return "0";
  if (compareDecimal(numerator, denominator) >= 0) return denominator;
  return numerator;
}

interface Completion {
  basis: PercentCompleteBasis;
  /** Completion as an exact ratio numerator/denominator in [0, 1]. */
  numerator: string;
  denominator: string;
}

/**
 * Percent-complete basis, in order of evidence strength: installed units
 * against a quantity budget, then the manual schedule progress of a
 * scheduled task, then cost-to-cost against the current cost budget (capped
 * at 100%). A task with none of the three is unmeasured.
 */
export function completionOf(input: Pick<
  TaskEarnedValueInput,
  "budgetQuantity" | "installedQuantity" | "scheduleProgress" | "actualCost" | "budgetCost"
>): Completion | null {
  if (positive(input.budgetQuantity)) {
    return {
      basis: "quantity",
      numerator: clampToWhole(input.installedQuantity, input.budgetQuantity),
      denominator: input.budgetQuantity,
    };
  }
  if (input.scheduleProgress !== null) {
    return { basis: "schedule", numerator: clampToWhole(input.scheduleProgress, "1"), denominator: "1" };
  }
  if (positive(input.budgetCost)) {
    return {
      basis: "cost",
      numerator: clampToWhole(input.actualCost, input.budgetCost),
      denominator: input.budgetCost,
    };
  }
  return null;
}

export function computeTaskEarnedValue(input: TaskEarnedValueInput): TaskEarnedValue {
  const bac = money(input.budgetCost);
  const actualCost = money(input.actualCost);
  const actualHours = hours(input.actualHours);
  const installed = quantity(input.installedQuantity);
  const completion = completionOf(input);

  const percentComplete = completion
    ? scaleBy("100", completion.numerator, completion.denominator, PERCENT_SCALE)
    : null;
  const earnedValue = completion
    ? scaleBy(bac, completion.numerator, completion.denominator, MONEY_SCALE)
    : money("0");

  const cpi = positive(actualCost) ? divideDecimal(earnedValue, actualCost, RATIO_SCALE) : null;

  const remainingBudget = maxZero(subtractDecimal(bac, actualCost, MONEY_SCALE), MONEY_SCALE);
  const etc = input.forecast ? money(input.forecast.costToComplete) : remainingBudget;
  const eac = addDecimal(actualCost, etc, MONEY_SCALE);
  const vac = subtractDecimal(bac, eac, MONEY_SCALE);

  const budgetHours = input.budgetHours === null ? null : hours(input.budgetHours);
  const hoursToComplete = input.forecast?.hoursToComplete != null
    ? hours(input.forecast.hoursToComplete)
    : budgetHours === null
      ? null
      : maxZero(subtractDecimal(budgetHours, actualHours, HOURS_SCALE), HOURS_SCALE);

  const productivity = positive(input.budgetQuantity) && positive(actualHours)
    ? divideDecimal(installed, actualHours, RATIO_SCALE)
    : null;

  const weeklyCostBurn = divideDecimal(money(input.trailingCost), String(BURN_WINDOW_WEEKS), MONEY_SCALE);
  const weeklyHoursBurn = divideDecimal(hours(input.trailingHours), String(BURN_WINDOW_WEEKS), HOURS_SCALE);
  const weeksToComplete = compareDecimal(etc, "0") === 0
    ? roundDecimal("0", WEEKS_SCALE)
    : positive(weeklyCostBurn)
      ? divideDecimal(etc, weeklyCostBurn, WEEKS_SCALE)
      : null;

  return {
    taskId: input.taskId,
    code: input.code,
    name: input.name,
    basis: completion?.basis ?? "none",
    percentComplete,
    budgetAtCompletion: bac,
    budgetQuantity: input.budgetQuantity === null ? null : quantity(input.budgetQuantity),
    budgetUnit: input.budgetUnit,
    installedQuantity: installed,
    earnedValue,
    actualCost,
    costPerformanceIndex: cpi,
    estimateToComplete: etc,
    estimateSource: input.forecast ? "forecast" : "remaining_budget",
    forecastMethod: input.forecast?.method ?? null,
    forecastAsOf: input.forecast?.asOfDate ?? null,
    estimateAtCompletion: eac,
    varianceAtCompletion: vac,
    budgetHours,
    actualHours,
    hoursToComplete,
    productivity,
    weeklyCostBurn,
    weeklyHoursBurn,
    weeksToComplete,
  };
}

export interface UnassignedActuals {
  actualCost: string;
  actualHours: string;
  trailingCost: string;
  trailingHours: string;
}

export interface ProjectEarnedValueTotals {
  /** EV ÷ BAC (0–100); null without a positive budget. */
  percentComplete: string | null;
  budgetAtCompletion: string;
  earnedValue: string;
  /** Task actuals plus the unassigned bucket. */
  actualCost: string;
  unassignedActualCost: string;
  costPerformanceIndex: string | null;
  estimateToComplete: string;
  estimateAtCompletion: string;
  varianceAtCompletion: string;
  budgetHours: string;
  actualHours: string;
  hoursToComplete: string;
  weeklyCostBurn: string;
  weeklyHoursBurn: string;
  weeksToComplete: string | null;
}

/**
 * Roll tasks up to the project. Cost not attributed to any task (the
 * unassigned bucket) is real project cost: it counts in AC, CPI and EAC, but
 * earns nothing and carries no estimate to complete.
 */
export function rollUpProjectEarnedValue(
  tasks: readonly TaskEarnedValue[],
  unassigned: UnassignedActuals,
): ProjectEarnedValueTotals {
  const total = (pick: (task: TaskEarnedValue) => string | null, scale: number) =>
    tasks.reduce((acc, task) => addDecimal(acc, pick(task) ?? "0", scale), roundDecimal("0", scale));
  const bac = total((task) => task.budgetAtCompletion, MONEY_SCALE);
  const ev = total((task) => task.earnedValue, MONEY_SCALE);
  const unassignedCost = money(unassigned.actualCost);
  const ac = addDecimal(total((task) => task.actualCost, MONEY_SCALE), unassignedCost, MONEY_SCALE);
  const etc = total((task) => task.estimateToComplete, MONEY_SCALE);
  const eac = addDecimal(ac, etc, MONEY_SCALE);
  const weeklyCostBurn = addDecimal(
    total((task) => task.weeklyCostBurn, MONEY_SCALE),
    divideDecimal(money(unassigned.trailingCost), String(BURN_WINDOW_WEEKS), MONEY_SCALE),
    MONEY_SCALE,
  );
  const weeklyHoursBurn = addDecimal(
    total((task) => task.weeklyHoursBurn, HOURS_SCALE),
    divideDecimal(hours(unassigned.trailingHours), String(BURN_WINDOW_WEEKS), HOURS_SCALE),
    HOURS_SCALE,
  );
  return {
    percentComplete: positive(bac) ? scaleBy("100", ev, bac, PERCENT_SCALE) : null,
    budgetAtCompletion: bac,
    earnedValue: ev,
    actualCost: ac,
    unassignedActualCost: unassignedCost,
    costPerformanceIndex: positive(ac) ? divideDecimal(ev, ac, RATIO_SCALE) : null,
    estimateToComplete: etc,
    estimateAtCompletion: eac,
    varianceAtCompletion: subtractDecimal(bac, eac, MONEY_SCALE),
    budgetHours: total((task) => task.budgetHours, HOURS_SCALE),
    actualHours: addDecimal(total((task) => task.actualHours, HOURS_SCALE), hours(unassigned.actualHours), HOURS_SCALE),
    hoursToComplete: total((task) => task.hoursToComplete, HOURS_SCALE),
    weeklyCostBurn,
    weeklyHoursBurn,
    weeksToComplete: compareDecimal(etc, "0") === 0
      ? roundDecimal("0", WEEKS_SCALE)
      : positive(weeklyCostBurn)
        ? divideDecimal(etc, weeklyCostBurn, WEEKS_SCALE)
        : null,
  };
}

export interface ForecastSuggestion {
  method: Exclude<ForecastMethod, "manual">;
  costToComplete: string;
  hoursToComplete: string | null;
}

/**
 * Estimate-to-complete candidates for one task, each a method the operator
 * can accept as-is:
 *
 *   remaining_budget    max(BAC − AC, 0)
 *   units_productivity  remaining quantity × actual cost per installed unit
 *                       (needs a quantity budget and installed units)
 *   cost_performance    (BAC − EV) ÷ CPI (needs a positive CPI)
 *
 * Hours follow the same method where the inputs exist.
 */
export function suggestTaskForecasts(input: TaskEarnedValueInput): ForecastSuggestion[] {
  const ev = computeTaskEarnedValue({ ...input, forecast: null });
  const suggestions: ForecastSuggestion[] = [{
    method: "remaining_budget",
    costToComplete: ev.estimateToComplete,
    hoursToComplete: ev.hoursToComplete,
  }];

  const installed = ev.installedQuantity;
  if (positive(input.budgetQuantity) && positive(installed)) {
    const remainingQuantity = maxZero(subtractDecimal(quantity(input.budgetQuantity), installed, QUANTITY_SCALE), QUANTITY_SCALE);
    suggestions.push({
      method: "units_productivity",
      costToComplete: maxZero(scaleBy(remainingQuantity, ev.actualCost, installed, MONEY_SCALE), MONEY_SCALE),
      hoursToComplete: positive(ev.actualHours)
        ? scaleBy(remainingQuantity, ev.actualHours, installed, HOURS_SCALE)
        : null,
    });
  }

  if (positive(ev.costPerformanceIndex) && positive(ev.earnedValue)) {
    // (BAC − EV) ÷ (EV ÷ AC) computed as (BAC − EV) × AC ÷ EV: one rounding.
    const remainingValue = maxZero(subtractDecimal(ev.budgetAtCompletion, ev.earnedValue, MONEY_SCALE), MONEY_SCALE);
    const budgetHours = ev.budgetHours;
    let hoursToComplete: string | null = null;
    if (budgetHours !== null && positive(ev.budgetAtCompletion) && positive(ev.actualHours)) {
      // Earned hours share the cost completion; remaining earned hours are
      // re-rated at the task's observed hours per earned hour.
      const earnedHours = scaleBy(budgetHours, ev.earnedValue, ev.budgetAtCompletion, HOURS_SCALE);
      if (positive(earnedHours)) {
        const remainingHours = maxZero(subtractDecimal(budgetHours, earnedHours, HOURS_SCALE), HOURS_SCALE);
        hoursToComplete = scaleBy(remainingHours, ev.actualHours, earnedHours, HOURS_SCALE);
      }
    }
    suggestions.push({
      method: "cost_performance",
      costToComplete: scaleBy(remainingValue, ev.actualCost, ev.earnedValue, MONEY_SCALE),
      hoursToComplete,
    });
  }
  return suggestions;
}
