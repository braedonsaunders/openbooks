import { sum as moneySum } from "@openbooks/engine/money/money";

/**
 * The forecast method for an open item whose predicted date fell before the
 * as-of date. The forecast then moves it to as-of plus a push interval that
 * depends only on how overdue it is, so every overdue item of a given age
 * band lands on the same date. Surfaces show that assumption next to the
 * amount, never as a bare figure.
 *
 * Client-safe: this module carries no server imports, so the cockpit and the
 * week flyout share it with the forecast engine that emits the method.
 */
export const OVERDUE_PUSH_METHOD = "Overdue push";

/** Method suffix a deferred prediction carries, e.g. "Global avg (deferred from 2026-08-30)". */
const DEFERRED_SUFFIX = /\s*\(deferred from [^)]*\)$/;

/** The method name without a deferral suffix. */
export function forecastMethodBase(method: string): string {
  return method.replace(DEFERRED_SUFFIX, "");
}

export function isOverduePushMethod(method: string): boolean {
  return forecastMethodBase(method) === OVERDUE_PUSH_METHOD;
}

/** The population behind a week's or horizon's overdue-push amount. */
export interface OverduePushBasis {
  /** Open items forecast by the push rule. */
  count: number;
  /** Youngest and oldest pushed item, in whole days past due. */
  minDaysOverdue: number;
  maxDaysOverdue: number;
  /** Sum of the pushed items' open amounts, in the entries' currency. */
  total: string;
}

/**
 * Count, age range and total of the entries forecast by the overdue push, or
 * null when none are. Pure over the entries the caller already displays, so
 * the basis always describes the same rows as the amount beside it.
 */
export function overduePushBasis(
  entries: readonly { method: string; daysOverdue: number; amount: string }[],
): OverduePushBasis | null {
  const pushed = entries.filter((entry) => isOverduePushMethod(entry.method));
  if (pushed.length === 0) return null;
  let minDaysOverdue = Number.POSITIVE_INFINITY;
  let maxDaysOverdue = Number.NEGATIVE_INFINITY;
  for (const entry of pushed) {
    minDaysOverdue = Math.min(minDaysOverdue, entry.daysOverdue);
    maxDaysOverdue = Math.max(maxDaysOverdue, entry.daysOverdue);
  }
  return {
    count: pushed.length,
    minDaysOverdue,
    maxDaysOverdue,
    total: moneySum(pushed.map((entry) => entry.amount)),
  };
}
