/** Pure recognition-schedule computation. Split from revenue/recognition.ts (ARCH-FILE-SPLIT; pure moves only). */
import { cmp, fromUnits, mulPercent, toUnits } from "../money/money.ts";
import { MAX_RECOGNITION_INITIAL_PERCENT, MAX_RECOGNITION_TERM_MONTHS, MIN_RECOGNITION_INITIAL_PERCENT } from "./recognition-limits.ts";
import { addDays, addMonths, daysInMonth, epochDay, eventMonth, inclusiveDays, monthEnd, monthStart, recognitionDate, recognitionInteger } from "./recognition-dates.ts";
import { apportion } from "./recognition-apportionment.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";

export type RecognitionMethod =
  | "point_in_time"
  | "straight_line_even"
  | "straight_line_prorate_first_last"
  | "straight_line_daily"
  | "percent_complete"
  | "milestone"
  | "usage";
// ---------------------------------------------------------------------------
// Schedule computation (pure)
// ---------------------------------------------------------------------------

export interface RecognitionInput {
  /** Amount to recognize over the term (post-allocation), decimal string. */
  total: string;
  method: RecognitionMethod;
  /** Recognition start, YYYY-MM-DD. */
  startOn: string;
  /** Recognition end, YYYY-MM-DD (required for prorate / daily precision). */
  endOn?: string | null;
  /** Term length in months, used when endOn is absent (even/prorate/daily). */
  termPeriods?: number | null;
  /** Shift the start date by N days before spreading. */
  startOffsetDays?: number | null;
  /** Percent (0..100) recognized up front in the first period. */
  initialAmountPercent?: string | null;
  /** Shift the whole schedule later by N periods (deferral). */
  periodOffset?: number | null;
  // percent_complete inputs:
  percentComplete?: string | null; // 0..100 cumulative target
  alreadyRecognized?: string | null; // recognized-to-date, decimal string
  /** Explicit period amounts for milestone / usage methods (YYYY-MM-01 → amount). */
  events?: { periodMonth: string; amount: string }[];
}

export interface RecognitionLinePlan {
  sequence: number;
  /** YYYY-MM-01 — the accounting month this recognition belongs to. */
  periodMonth: string;
  /** planned recognition for the month, decimal string (may be 0). */
  planned: string;
  /** cumulative recognized through and including this month. */
  cumulative: string;
}

/** Cumulative-percent × total, exact to 4dp. */
export function pctOf(totalUnits: bigint, pct: string): bigint {
  try {
    if (cmp(pct, MIN_RECOGNITION_INITIAL_PERCENT) < 0 || cmp(pct, MAX_RECOGNITION_INITIAL_PERCENT) > 0) throw new Error("out of range");
    return toUnits(mulPercent(fromUnits(totalUnits), pct, 4));
  } catch {
    throw new RevenueRecognitionError(`recognition percentage must be a decimal from ${MIN_RECOGNITION_INITIAL_PERCENT} through ${MAX_RECOGNITION_INITIAL_PERCENT}`);
  }
}

/** Resolve the term end from an explicit endOn, else start + termPeriods. */
function resolveEnd(startOn: string, input: RecognitionInput): string {
  if (input.endOn) return input.endOn;
  const term = recognitionInteger(input.termPeriods ?? 1, "recognition term", 1);
  return monthEnd(addMonths(monthStart(startOn), term - 1));
}

/** Whole calendar months a term spans, inclusive of first and last. */
function monthSpan(startOn: string, endOn: string): number {
  const [sy, sm] = monthStart(startOn).split("-").map(Number);
  const [ey, em] = monthStart(endOn).split("-").map(Number);
  return ey! * 12 + (em! - 1) - (sy! * 12 + (sm! - 1)) + 1;
}

/**
 * Spread the total across the given month weights, honoring an initial up-front
 * percentage recognized in the first period on top of its ratable share.
 * Returns { month, units } aligned to `start` + i months.
 */
function spreadWithInitial(input: RecognitionInput, start: string, weights: number[]): { month: string; units: bigint }[] {
  const totalUnits = toUnits(input.total);
  const initialUnits = pctOf(totalUnits, input.initialAmountPercent ?? "0");
  const parts = apportion(totalUnits - initialUnits, weights);
  if (weights.length > 0) parts[0]! += initialUnits;
  return parts.map((units, i) => ({ month: addMonths(start, i), units }));
}

/**
 * Compute the period-by-period recognition plan for one obligation. Every
 * method recognizes from the (offset) start month forward and sums EXACTLY to
 * the recognizable amount — the apportionment never loses or invents a cent.
 */
export function computeRecognitionSchedule(input: RecognitionInput): RecognitionLinePlan[] {
  recognitionDate(input.startOn, "recognition start");
  if (input.endOn != null) recognitionDate(input.endOn, "recognition end");
  if (input.termPeriods != null) {
    recognitionInteger(input.termPeriods, "recognition term", 1);
    if (input.termPeriods > MAX_RECOGNITION_TERM_MONTHS) {
      throw new RevenueRecognitionError(
        `recognition term must be a whole number from 1 through ${MAX_RECOGNITION_TERM_MONTHS} months`,
      );
    }
  }
  const periodOffset = recognitionInteger(input.periodOffset ?? 0, "period offset", 0);
  if (periodOffset > MAX_RECOGNITION_TERM_MONTHS) {
    throw new RevenueRecognitionError(
      `period offset must be a whole number from 0 through ${MAX_RECOGNITION_TERM_MONTHS}`,
    );
  }
  const rawStart = addDays(input.startOn, input.startOffsetDays ?? 0);
  const start = monthStart(rawStart);

  // Fail closed on an inverted term: end-before-start clamps every weight to
  // zero in apportion(), silently planning an all-zero schedule instead of
  // recognizing anything.
  if (
    input.method === "straight_line_even" ||
    input.method === "straight_line_prorate_first_last" ||
    input.method === "straight_line_daily"
  ) {
    const end = resolveEnd(rawStart, input);
    if (epochDay(end) < epochDay(rawStart)) {
      throw new RevenueRecognitionError(`recognition end (${end}) precedes the recognition start (${rawStart})`);
    }
    // Cap explicit endOn spans too: without this, a centuries-wide date
    // range allocates one array entry per month before anything else runs.
    if (monthSpan(rawStart, end) > MAX_RECOGNITION_TERM_MONTHS) {
      throw new RevenueRecognitionError(
        `recognition schedule must span no more than ${MAX_RECOGNITION_TERM_MONTHS} months`,
      );
    }
  }

  const lines: { month: string; units: bigint }[] = (() => {
    switch (input.method) {
      case "point_in_time":
        return [{ month: start, units: toUnits(input.total) }];

      case "percent_complete": {
        // Cumulative catch-up, BOTH directions (ASC 606 over-time): a falling
        // estimate reverses previously recognized revenue in the current period.
        const targetUnits = pctOf(toUnits(input.total), input.percentComplete ?? "0");
        const already = toUnits(input.alreadyRecognized ?? "0");
        return [{ month: start, units: targetUnits - already }];
      }

      case "milestone":
      case "usage":
        return (input.events ?? []).map((e) => {
          eventMonth(e.periodMonth);
          return { month: e.periodMonth, units: toUnits(e.amount) };
        });

      case "straight_line_even": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        return spreadWithInitial(input, start, new Array(n).fill(1));
      }

      case "straight_line_prorate_first_last": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        const weights: number[] = [];
        for (let i = 0; i < n; i++) {
          const m = addMonths(start, i);
          if (n === 1) weights.push(inclusiveDays(rawStart, end));
          else if (i === 0) weights.push(inclusiveDays(rawStart, monthEnd(rawStart)));
          else if (i === n - 1) weights.push(inclusiveDays(m, end));
          else weights.push(daysInMonth(m));
        }
        return spreadWithInitial(input, start, weights);
      }

      case "straight_line_daily": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        const weights: number[] = [];
        for (let i = 0; i < n; i++) {
          const m = addMonths(start, i);
          const segStart = i === 0 ? rawStart : m;
          const segEnd = i === n - 1 ? end : monthEnd(m);
          weights.push(inclusiveDays(segStart, segEnd));
        }
        return spreadWithInitial(input, start, weights);
      }

      default:
        throw new RevenueRecognitionError("invalid recognition method");
    }
  })();

  let cumulative = 0n;
  return lines.map((l, idx) => {
    cumulative += l.units;
    return {
      sequence: idx,
      periodMonth: addMonths(l.month, periodOffset),
      planned: fromUnits(l.units),
      cumulative: fromUnits(cumulative),
    };
  });
}
