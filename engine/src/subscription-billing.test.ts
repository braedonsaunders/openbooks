import assert from "node:assert/strict";
import test from "node:test";
import { advanceSubscription, monthlyRecurringRevenue } from "./subscription-billing.ts";

test("advanceSubscription steps by interval × count with month-end clamp", () => {
  assert.equal(advanceSubscription("2026-01-15", "monthly", 1), "2026-02-15");
  assert.equal(advanceSubscription("2026-01-31", "monthly", 1), "2026-02-28");
  assert.equal(advanceSubscription("2026-01-10", "monthly", 3), "2026-04-10");
  assert.equal(advanceSubscription("2026-11-30", "quarterly", 1), "2027-02-28");
  assert.equal(advanceSubscription("2026-07-21", "annually", 1), "2027-07-21");
  assert.equal(advanceSubscription("2026-07-21", "weekly", 2), "2026-08-04");
});

test("monthlyRecurringRevenue normalizes each interval to a monthly figure", () => {
  assert.equal(monthlyRecurringRevenue("100", "monthly", 1, "1"), 100);
  assert.equal(monthlyRecurringRevenue("100", "monthly", 1, "3"), 300);
  assert.equal(monthlyRecurringRevenue("1200", "annually", 1, "1"), 100);
  assert.equal(monthlyRecurringRevenue("300", "quarterly", 1, "1"), 100);
  assert.equal(monthlyRecurringRevenue("300", "monthly", 3, "1"), 100);
});
