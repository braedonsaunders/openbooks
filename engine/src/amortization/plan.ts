/**
 * Pure amortization plan math. Every amount is a bigint in ledger units
 * (numeric(19,4) scaled by 10^4) and every date a civil YYYY-MM-DD string,
 * so a plan is deterministic and recomputable from its inputs alone: the
 * same template, window and amount always produce the same periods and the
 * same amounts, to the unit.
 *
 * Periods are calendar months. Each method turns the amortization window
 * into one non-negative weight per month; the amount is split by weight in
 * whole currency quanta, and the remainder lands in the last period that
 * carries weight (the "remainder to last period" rounding policy), so the
 * periods always sum exactly to the amount.
 */
import {
  addCalendarDays,
  addMonthsClamped,
  addMonthsStart,
  civilDayIndex,
  daysInCivilMonth,
  endOfMonth,
  isIsoCalendarDate,
  startOfMonth,
} from "../platform/civil-date.ts";
import { AmortizationError } from "./errors.ts";

export const AMORTIZATION_METHODS = [
  "straight_line",
  "prorated_first_last",
  "exact_days",
  "variable",
] as const;
export type AmortizationMethod = (typeof AMORTIZATION_METHODS)[number];

export const AMORTIZATION_TERM_SOURCES = ["template", "service_dates"] as const;
export type AmortizationTermSource = (typeof AMORTIZATION_TERM_SOURCES)[number];

export const AMORTIZATION_ROUNDING = "remainder_last_period" as const;

/** Longest supported plan: fifty years of monthly periods. */
export const MAX_AMORTIZATION_PERIODS = 600;
/** Longest supported start delay, in periods. */
export const MAX_AMORTIZATION_PERIOD_OFFSET = 120;
/** Percentages in a variable table carry at most six decimals. */
export const AMORTIZATION_PERCENT_SCALE = 6;
const PERCENT_UNIT = 10n ** BigInt(AMORTIZATION_PERCENT_SCALE);
const HUNDRED_PERCENT = 100n * PERCENT_UNIT;
/** Least common multiple of every month length (28–31 days): a day fraction
 * of any month is an exact integer over this denominator. */
const MONTH_DAY_LCM = 377_580n;

export interface AmortizationPolicy {
  method: AmortizationMethod;
  termSource: AmortizationTermSource;
  /** Number of periods for a template term (and the table length for variable). */
  periodCount: number | null;
  /** Variable method only: one percentage per period, summing to exactly 100. */
  percentages: readonly string[] | null;
  /** Periods between the start of the term and the first amortization period. */
  periodOffset: number;
}

export interface AmortizationTermInput {
  /** The source line's service start, when it carries one. */
  serviceStartOn: string | null;
  /** The source line's service end, when it carries one. */
  serviceEndOn: string | null;
  /** The source transaction's posting date: the start when no service start is given. */
  transactionDate: string;
}

/** The resolved amortization term: the service window and its first period. */
export interface AmortizationTerm {
  startOn: string;
  endOn: string;
  /** Month start of the first amortization period (offset applied). */
  firstPeriodOn: string;
  /** Number of monthly periods the plan spans. */
  periodCount: number;
}

export interface PlannedPeriod {
  /** First day of the calendar month. */
  periodStart: string;
  /** Last day of the calendar month. */
  periodEnd: string;
  /** Ledger units (4dp, scaled by 10^4). */
  amount: bigint;
}

function refuse(message: string, code: string, remedy: string): never {
  throw new AmortizationError(message, { code, remedy });
}

function requireDate(value: string, label: string): void {
  if (!isIsoCalendarDate(value)) {
    refuse(
      `${label} must be a valid YYYY-MM-DD date.`,
      "amortization_date_invalid",
      `Enter ${label} as YYYY-MM-DD.`,
    );
  }
}

/** Inclusive month count from the month of `fromIso` to the month of `toIso`. */
export function monthSpan(fromIso: string, toIso: string): number {
  const from = startOfMonth(fromIso);
  const to = startOfMonth(toIso);
  return (
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
    1
  );
}

function requirePeriodCount(count: number | null, label: string): number {
  if (
    count === null ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_AMORTIZATION_PERIODS
  ) {
    refuse(
      `${label} must be a whole number of periods from 1 through ${MAX_AMORTIZATION_PERIODS}.`,
      "amortization_period_count_invalid",
      "Set the template's number of periods, or choose a term taken from the line's service dates.",
    );
  }
  return count;
}

/**
 * Parse a variable table: exact decimals with at most six places, none
 * negative, summing to exactly 100. Returns each percentage in millionths.
 */
export function parsePercentageTable(percentages: readonly string[] | null): bigint[] {
  if (!percentages || percentages.length === 0) {
    refuse(
      "A variable template needs a percentage table.",
      "amortization_percentages_missing",
      "Enter one percentage per period in the template's percentage table.",
    );
  }
  if (percentages.length > MAX_AMORTIZATION_PERIODS) {
    refuse(
      `A percentage table holds at most ${MAX_AMORTIZATION_PERIODS} periods.`,
      "amortization_percentages_too_long",
      "Shorten the percentage table.",
    );
  }
  const parsed = percentages.map((raw, index) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    const match = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(text);
    if (!match) {
      refuse(
        `Period ${index + 1} percentage "${String(raw)}" is not a decimal from 0 to 100 with at most ${AMORTIZATION_PERCENT_SCALE} places.`,
        "amortization_percentage_invalid",
        "Enter each period's percentage as a plain decimal such as 8.333333.",
      );
    }
    return (
      BigInt(match[1]!) * PERCENT_UNIT +
      BigInt((match[2] ?? "").padEnd(AMORTIZATION_PERCENT_SCALE, "0"))
    );
  });
  const total = parsed.reduce((acc, value) => acc + value, 0n);
  if (total !== HUNDRED_PERCENT) {
    refuse(
      `The percentage table sums to ${formatPercent(total)}%, not 100%.`,
      "amortization_percentages_total",
      "Adjust the percentages so they sum to exactly 100.",
    );
  }
  return parsed;
}

function formatPercent(millionths: bigint): string {
  const whole = millionths / PERCENT_UNIT;
  const fraction = (millionths % PERCENT_UNIT)
    .toString()
    .padStart(AMORTIZATION_PERCENT_SCALE, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Validate a template policy without any source context. */
export function validateAmortizationPolicy(policy: AmortizationPolicy): void {
  if (!AMORTIZATION_METHODS.includes(policy.method)) {
    refuse(
      `Unknown amortization method ${String(policy.method)}.`,
      "amortization_method_invalid",
      "Choose a supported amortization method.",
    );
  }
  if (!AMORTIZATION_TERM_SOURCES.includes(policy.termSource)) {
    refuse(
      `Unknown term source ${String(policy.termSource)}.`,
      "amortization_term_source_invalid",
      "Choose the template's period count or the line's service dates as the term.",
    );
  }
  if (
    !Number.isSafeInteger(policy.periodOffset) ||
    policy.periodOffset < 0 ||
    policy.periodOffset > MAX_AMORTIZATION_PERIOD_OFFSET
  ) {
    refuse(
      `The period offset must be a whole number from 0 through ${MAX_AMORTIZATION_PERIOD_OFFSET}.`,
      "amortization_offset_invalid",
      "Enter how many periods after the start amortization begins (0 starts immediately).",
    );
  }
  if (policy.method === "variable") {
    if (policy.termSource !== "template") {
      refuse(
        "A variable template takes its term from its percentage table, not from service dates.",
        "amortization_variable_term",
        "Set the term source of a variable template to the template's periods.",
      );
    }
    const table = parsePercentageTable(policy.percentages);
    if (policy.periodCount !== table.length) {
      refuse(
        `The template names ${policy.periodCount ?? 0} periods but its percentage table has ${table.length}.`,
        "amortization_percentages_count",
        "Make the number of periods equal the number of rows in the percentage table.",
      );
    }
    return;
  }
  if (policy.percentages && policy.percentages.length > 0) {
    refuse(
      "Only a variable template carries a percentage table.",
      "amortization_percentages_unexpected",
      "Clear the percentage table, or switch the method to variable.",
    );
  }
  if (policy.termSource === "template")
    requirePeriodCount(policy.periodCount, "The template's number of periods");
}

/**
 * Resolve the service window and first period for one source line. A
 * template term starts on the line's service start (or the transaction date)
 * and spans the template's periods; a service-dates term needs both dates.
 */
export function resolveAmortizationTerm(
  policy: AmortizationPolicy,
  input: AmortizationTermInput,
): AmortizationTerm {
  validateAmortizationPolicy(policy);
  requireDate(input.transactionDate, "the transaction date");
  if (input.serviceStartOn !== null) requireDate(input.serviceStartOn, "the service start date");
  if (input.serviceEndOn !== null) requireDate(input.serviceEndOn, "the service end date");
  let startOn: string;
  let endOn: string;
  let periodCount: number;
  if (policy.termSource === "service_dates") {
    if (input.serviceStartOn === null || input.serviceEndOn === null) {
      refuse(
        "This amortization template takes its term from the line's service dates, and the line has none.",
        "amortization_service_dates_missing",
        "Enter the service start and end dates on the line, or choose a template with a fixed number of periods.",
      );
    }
    startOn = input.serviceStartOn;
    endOn = input.serviceEndOn;
    if (civilDayIndex(endOn) < civilDayIndex(startOn)) {
      refuse(
        `The service end ${endOn} is before the service start ${startOn}.`,
        "amortization_service_dates_inverted",
        "Correct the line's service dates so the end is on or after the start.",
      );
    }
    periodCount = monthSpan(startOn, endOn);
  } else {
    startOn = input.serviceStartOn ?? input.transactionDate;
    periodCount = requirePeriodCount(policy.periodCount, "The template's number of periods");
    // By-period methods run whole months; day-based methods run the exact
    // anniversary window, which can touch one more calendar month.
    endOn = addCalendarDays(addMonthsClamped(startOn, periodCount), -1);
    if (policy.method === "straight_line" || policy.method === "variable") {
      endOn = endOfMonth(addMonthsStart(startOn, periodCount - 1));
    } else {
      periodCount = monthSpan(startOn, endOn);
    }
  }
  if (periodCount > MAX_AMORTIZATION_PERIODS) {
    refuse(
      `The term spans ${periodCount} periods; at most ${MAX_AMORTIZATION_PERIODS} are supported.`,
      "amortization_term_too_long",
      "Shorten the service window or the template's number of periods.",
    );
  }
  return {
    startOn,
    endOn,
    firstPeriodOn: addMonthsStart(startOn, policy.periodOffset),
    periodCount,
  };
}

function overlapDays(monthStart: string, startOn: string, endOn: string): bigint {
  const from = Math.max(civilDayIndex(monthStart), civilDayIndex(startOn));
  const to = Math.min(civilDayIndex(endOfMonth(monthStart)), civilDayIndex(endOn));
  return to >= from ? BigInt(to - from + 1) : 0n;
}

/**
 * One weight per term month (before the offset shift). Straight-line weighs
 * every month equally; exact days weighs each month by the service days it
 * holds; prorated first and last weighs full months equally and partial
 * months by their share of the month's days; variable uses the table.
 */
export function termWeights(policy: AmortizationPolicy, term: AmortizationTerm): bigint[] {
  const months = Array.from({ length: term.periodCount }, (_, i) =>
    addMonthsStart(term.startOn, i),
  );
  switch (policy.method) {
    case "straight_line":
      return months.map(() => 1n);
    case "exact_days":
      return months.map((month) => overlapDays(month, term.startOn, term.endOn));
    case "prorated_first_last":
      return months.map((month) => {
        const days = BigInt(daysInCivilMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))));
        return (overlapDays(month, term.startOn, term.endOn) * MONTH_DAY_LCM) / days;
      });
    case "variable": {
      const table = parsePercentageTable(policy.percentages);
      if (table.length !== months.length) {
        refuse(
          `The percentage table has ${table.length} periods but the term spans ${months.length}.`,
          "amortization_percentages_count",
          "Make the template's number of periods equal its percentage table.",
        );
      }
      return table;
    }
  }
}

/**
 * Split `total` across `weights` in whole quanta, flooring every period but
 * the last weighted one, which takes the remainder. The parts sum exactly to
 * the total and never go negative.
 */
export function allocateRemainderToLast(
  total: bigint,
  weights: readonly bigint[],
  quantum: bigint,
): bigint[] {
  if (total < 0n)
    refuse(
      "An amortization amount cannot be negative.",
      "amortization_amount_negative",
      "Amortize a positive amount.",
    );
  if (quantum <= 0n) throw new AmortizationError("The currency quantum must be positive.");
  if (weights.some((weight) => weight < 0n))
    throw new AmortizationError("Amortization weights cannot be negative.");
  const totalWeight = weights.reduce((acc, weight) => acc + weight, 0n);
  if (totalWeight === 0n) {
    refuse(
      "No period of the amortization term carries any weight.",
      "amortization_zero_weights",
      "Check the template's percentage table and the line's service dates.",
    );
  }
  let last = -1;
  weights.forEach((weight, index) => {
    if (weight > 0n) last = index;
  });
  const parts = weights.map((weight, index) =>
    index === last ? 0n : ((total * weight) / totalWeight / quantum) * quantum,
  );
  parts[last] = total - parts.reduce((acc, part) => acc + part, 0n);
  return parts;
}

/**
 * The allocation quantum for an amount: one minor unit of the currency when
 * the amount is a whole number of minor units, else one ledger unit. A plan
 * never invents a precision the amount does not carry.
 */
export function planQuantum(total: bigint, currencyExponent: number): bigint {
  if (!Number.isInteger(currencyExponent) || currencyExponent < 0 || currencyExponent > 4) {
    throw new AmortizationError(`Unsupported currency exponent ${currencyExponent}.`, {
      code: "amortization_currency_exponent",
      remedy: "Amortize in a currency with at most four minor-unit decimals.",
    });
  }
  const minor = 10n ** BigInt(4 - currencyExponent);
  return total % minor === 0n ? minor : 1n;
}

/** The full plan for a term: one period per month, shifted by the offset. */
export function buildAmortizationPlan(
  policy: AmortizationPolicy,
  term: AmortizationTerm,
  total: bigint,
  quantum: bigint,
): PlannedPeriod[] {
  if (total <= 0n) {
    refuse(
      "Amortize a positive amount.",
      "amortization_amount_not_positive",
      "Only a positive deferral can be amortized; post credits as a schedule reduction.",
    );
  }
  const amounts = allocateRemainderToLast(total, termWeights(policy, term), quantum);
  return amounts.map((amount, index) => {
    const periodStart = addMonthsStart(term.firstPeriodOn, index);
    return { periodStart, periodEnd: endOfMonth(periodStart), amount };
  });
}

/**
 * Re-forecast an unamortized balance from `fromPeriod` onward. Without a
 * term change the remaining periods keep their method weights; with a new
 * last period the balance spreads evenly over the new remaining periods
 * (a variable table cannot be stretched, so it refuses).
 */
export function reforecastAmortizationPlan(input: {
  policy: AmortizationPolicy;
  /** The current live plan, in period order (posted and unposted). */
  currentPlan: readonly { periodStart: string; weight: bigint }[];
  remaining: bigint;
  fromPeriod: string;
  newLastPeriod?: string | null;
  quantum: bigint;
}): PlannedPeriod[] {
  const fromPeriod = startOfMonth(input.fromPeriod);
  if (input.remaining < 0n)
    refuse(
      "The remaining balance is negative.",
      "amortization_remaining_negative",
      "Review the schedule's posted amortization.",
    );
  if (input.remaining === 0n) return [];
  let periods: { periodStart: string; weight: bigint }[];
  if (input.newLastPeriod) {
    if (input.policy.method === "variable") {
      refuse(
        "A variable schedule follows its percentage table and its term cannot change.",
        "amortization_variable_term_change",
        "Cancel the schedule with a write-off, or create a manual schedule for the remaining balance.",
      );
    }
    const last = startOfMonth(input.newLastPeriod);
    const count = monthSpan(fromPeriod, last);
    if (count < 1) {
      refuse(
        `The new last period ${last.slice(0, 7)} is before the change period ${fromPeriod.slice(0, 7)}.`,
        "amortization_term_change_inverted",
        "Choose a last period on or after the period the change takes effect.",
      );
    }
    if (count > MAX_AMORTIZATION_PERIODS) {
      refuse(
        `The new term spans ${count} periods; at most ${MAX_AMORTIZATION_PERIODS} are supported.`,
        "amortization_term_too_long",
        "Choose an earlier last period.",
      );
    }
    periods = Array.from({ length: count }, (_, i) => ({
      periodStart: addMonthsStart(fromPeriod, i),
      weight: 1n,
    }));
  } else {
    periods = input.currentPlan.filter(
      (period) => civilDayIndex(period.periodStart) >= civilDayIndex(fromPeriod),
    );
    if (periods.length === 0 || periods.every((period) => period.weight === 0n)) {
      // Past the end of the plan: the balance lands in the change period.
      periods = [{ periodStart: fromPeriod, weight: 1n }];
    }
  }
  const amounts = allocateRemainderToLast(
    input.remaining,
    periods.map((period) => period.weight),
    input.quantum,
  );
  return periods.map((period, index) => ({
    periodStart: period.periodStart,
    periodEnd: endOfMonth(period.periodStart),
    amount: amounts[index]!,
  }));
}
