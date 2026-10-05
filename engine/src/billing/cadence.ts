/**
 * Shared month-step arithmetic for subscription billing and recurring
 * schedules — one helper, not two. Both engines bill on an anchor
 * day-of-month: each next date advances the YEAR-MONTH from the current
 * date but takes the DAY from the stored anchor, clamped to the target
 * month's length. Advancing the day from the already-clamped date instead
 * drifts month-end starts (Jan 31 → Feb 28 → Mar 28 …); the anchor pins
 * them (Jan 31 → Feb 28 → Mar 31).
 *
 * Pure date math on numbers (no Date reads, no timezone): callers validate
 * their own inputs and map the thrown Errors to their domain errors.
 */

import { daysInCivilMonth } from "../platform/civil-date.ts";

/**
 * Advance (year, month1) by monthStep months, pinning the day to anchorDay
 * clamped to the target month's length. Returns zero-padded YYYY-MM-DD.
 * Throws Error on a non-calendar source month, a non-positive step, an
 * anchor outside 1..31, or a target year outside 1..9999.
 */
export function advanceAnchoredMonth(
  year: number,
  month1: number,
  monthStep: number,
  anchorDay: number,
): string {
  return shiftAnchoredMonth(year, month1, monthStep, anchorDay, 1);
}

/**
 * Step (year, month1) BACK by monthStep months with the same anchor pinning
 * as advanceAnchoredMonth, so a retreat followed by an advance of the same
 * step returns to an anchored date (Feb 28 with anchor 31 retreats one
 * quarter to Nov 30, which advances back to Feb 28). Same refusals.
 */
export function retreatAnchoredMonth(
  year: number,
  month1: number,
  monthStep: number,
  anchorDay: number,
): string {
  return shiftAnchoredMonth(year, month1, monthStep, anchorDay, -1);
}

function shiftAnchoredMonth(
  year: number,
  month1: number,
  monthStep: number,
  anchorDay: number,
  direction: 1 | -1,
): string {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month1) || month1 < 1 || month1 > 12) {
    throw new Error("cadence source month is not a valid calendar month");
  }
  if (!Number.isSafeInteger(monthStep) || monthStep < 1) {
    throw new Error("cadence month step must be a positive integer");
  }
  if (!Number.isSafeInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new Error("cadence anchor day must be between 1 and 31");
  }
  const targetMonthIndex = month1 - 1 + direction * monthStep;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  if (!Number.isSafeInteger(targetYear) || targetYear < 1 || targetYear > 9999) {
    throw new Error("cadence step falls outside the supported date range");
  }
  const targetMonth1 = ((targetMonthIndex % 12) + 12) % 12 + 1;
  const day = Math.min(anchorDay, daysInCivilMonth(targetYear, targetMonth1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(targetYear).padStart(4, "0")}-${pad(targetMonth1)}-${pad(day)}`;
}
