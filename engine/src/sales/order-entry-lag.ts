import { calendarDaysBetween } from "../platform/civil-date.ts";

/**
 * A purchase order entered more than this many days after its order date is
 * flagged on the record and in its approval view. One day covers ordinary
 * time-zone and end-of-day entry; anything beyond it is a back-dated or late
 * commitment an approver should see.
 */
export const ENTERED_AFTER_ORDER_DATE_NOTICE_DAYS = 1;

/**
 * Whole days between a purchase order's order date and the business day it was
 * entered, when that gap is past the notice threshold; null otherwise. Both
 * arguments are ISO calendar dates in the organization's business zone. An
 * order dated after its entry day is not a lag and yields null.
 */
export function enteredAfterOrderDays(orderDate: string, enteredOn: string): number | null {
  const days = calendarDaysBetween(orderDate, enteredOn);
  return days > ENTERED_AFTER_ORDER_DATE_NOTICE_DAYS ? days : null;
}
