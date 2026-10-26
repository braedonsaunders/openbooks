import assert from "node:assert/strict";
import test from "node:test";
import { enteredAfterOrderDays, ENTERED_AFTER_ORDER_DATE_NOTICE_DAYS } from "./order-entry-lag.ts";

test("a purchase order entered months after its order date reports the whole-day gap", () => {
  // A commitment entered almost a year after its order date.
  assert.equal(enteredAfterOrderDays("2025-11-14", "2026-10-11"), 331);
});

test("entry on the order date or one day after it is not notable", () => {
  assert.equal(ENTERED_AFTER_ORDER_DATE_NOTICE_DAYS, 1);
  assert.equal(enteredAfterOrderDays("2026-10-11", "2026-10-11"), null);
  assert.equal(enteredAfterOrderDays("2026-10-10", "2026-10-11"), null);
});

test("entry two days after the order date is notable, across a month boundary", () => {
  assert.equal(enteredAfterOrderDays("2026-01-30", "2026-02-01"), 2);
});

test("an order dated after its entry day is not a lag", () => {
  assert.equal(enteredAfterOrderDays("2026-10-20", "2026-10-11"), null);
});
