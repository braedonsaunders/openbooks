import assert from "node:assert/strict";
import test from "node:test";
import {
  forecastMethodBase,
  isOverduePushMethod,
  OVERDUE_PUSH_METHOD,
  overduePushBasis,
} from "./overdue-push";

test("the overdue push method is recognised with and without a deferral suffix", () => {
  assert.equal(OVERDUE_PUSH_METHOD, "Overdue push");
  assert.equal(isOverduePushMethod("Overdue push"), true);
  assert.equal(isOverduePushMethod("Overdue push (deferred from 2026-08-30)"), true);
  assert.equal(isOverduePushMethod("Statistical"), false);
  assert.equal(isOverduePushMethod("Global avg (deferred from 2026-08-30)"), false);
  assert.equal(forecastMethodBase("Overdue push (deferred from 2026-08-30)"), "Overdue push");
  assert.equal(forecastMethodBase("Due date"), "Due date");
});

test("no basis is reported when no item is forecast by the push", () => {
  assert.equal(overduePushBasis([]), null);
  assert.equal(
    overduePushBasis([{ method: "Statistical", daysOverdue: 0, amount: "100.0000" }]),
    null,
  );
});

test("the basis counts the pushed items, their age range and their exact total", () => {
  const basis = overduePushBasis([
    { method: "Overdue push", daysOverdue: 180, amount: "20000.1000" },
    { method: "Overdue push", daysOverdue: 360, amount: "14999.9000" },
    { method: "Overdue push (deferred from 2026-08-30)", daysOverdue: 210, amount: "0.0100" },
    { method: "Statistical", daysOverdue: 5, amount: "9999.0000" },
  ]);
  assert.deepEqual(basis, {
    count: 3,
    minDaysOverdue: 180,
    maxDaysOverdue: 360,
    total: "35000.0100",
  });
});

test("a single pushed age reports the same youngest and oldest day", () => {
  const basis = overduePushBasis([{ method: "Overdue push", daysOverdue: 75, amount: "250.0000" }]);
  assert.deepEqual(basis, { count: 1, minDaysOverdue: 75, maxDaysOverdue: 75, total: "250.0000" });
});
