import { cmp } from "../money/money.ts";

/**
 * Shared bounds for recognition-rule policy fields. recognition.ts enforces
 * these when it builds and posts schedules; the setup registry declares the
 * same bounds so the UI shows them, and recognitionRulePolicyProblem refuses
 * out-of-range saves with the same limits. Single source: do not restate
 * these numbers anywhere else.
 */

/** Supported recognition schedule horizon: 100 years of monthly periods. */
export const MAX_RECOGNITION_TERM_MONTHS = 1200;
/** A recognition term names at least one month. */
export const MIN_RECOGNITION_TERM_MONTHS = 1;
/** A period offset shifts forward from the start month, never backward. */
export const MIN_RECOGNITION_PERIOD_OFFSET = 0;
/** 32-bit day range backing recognitionInteger and the day-offset shift. */
export const MIN_RECOGNITION_DAY_OFFSET = -2147483648;
export const MAX_RECOGNITION_DAY_OFFSET = 2147483647;
/** Up-front recognition percentage bounds, matching pctOf. */
export const MIN_RECOGNITION_INITIAL_PERCENT = "0";
export const MAX_RECOGNITION_INITIAL_PERCENT = "100";

export interface RecognitionRulePolicy {
  recognitionPeriods?: unknown;
  periodOffset?: unknown;
  startOffsetDays?: unknown;
  initialAmountPercent?: unknown;
}

/** A value the operator actually supplied (blank falls through to defaults). */
function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Exactly one engine-side recognition-rule policy check. Returns the first
 * refusal naming its field, or null when the policy is saveable. Absent
 * values are skipped: recognitionPeriods is nullable and the remaining
 * fields fall through to their database defaults.
 */
export function recognitionRulePolicyProblem(
  policy: RecognitionRulePolicy,
): string | null {
  if (present(policy.recognitionPeriods)) {
    const periods = wholeNumber(policy.recognitionPeriods);
    if (
      periods === null ||
      !Number.isSafeInteger(periods) ||
      periods < MIN_RECOGNITION_TERM_MONTHS ||
      periods > MAX_RECOGNITION_TERM_MONTHS
    ) {
      return `recognitionPeriods must be a whole number from ${MIN_RECOGNITION_TERM_MONTHS} through ${MAX_RECOGNITION_TERM_MONTHS}`;
    }
  }
  if (present(policy.periodOffset)) {
    const offset = wholeNumber(policy.periodOffset);
    if (
      offset === null ||
      !Number.isSafeInteger(offset) ||
      offset < MIN_RECOGNITION_PERIOD_OFFSET ||
      offset > MAX_RECOGNITION_TERM_MONTHS
    ) {
      return `periodOffset must be a whole number from ${MIN_RECOGNITION_PERIOD_OFFSET} through ${MAX_RECOGNITION_TERM_MONTHS}`;
    }
  }
  if (present(policy.startOffsetDays)) {
    const dayOffset = wholeNumber(policy.startOffsetDays);
    if (
      dayOffset === null ||
      !Number.isSafeInteger(dayOffset) ||
      dayOffset < MIN_RECOGNITION_DAY_OFFSET ||
      dayOffset > MAX_RECOGNITION_DAY_OFFSET
    ) {
      return `startOffsetDays must be a whole number from ${MIN_RECOGNITION_DAY_OFFSET} through ${MAX_RECOGNITION_DAY_OFFSET}`;
    }
  }
  if (present(policy.initialAmountPercent)) {
    let inRange = false;
    try {
      const raw =
        typeof policy.initialAmountPercent === "number"
          ? String(policy.initialAmountPercent)
          : typeof policy.initialAmountPercent === "string"
            ? policy.initialAmountPercent.trim()
            : policy.initialAmountPercent;
      inRange =
        typeof raw === "string" &&
        cmp(raw, MIN_RECOGNITION_INITIAL_PERCENT) >= 0 &&
        cmp(raw, MAX_RECOGNITION_INITIAL_PERCENT) <= 0;
    } catch {
      inRange = false;
    }
    if (!inRange) {
      return `initialAmountPercent must be a decimal from ${MIN_RECOGNITION_INITIAL_PERCENT} through ${MAX_RECOGNITION_INITIAL_PERCENT}`;
    }
  }
  return null;
}
