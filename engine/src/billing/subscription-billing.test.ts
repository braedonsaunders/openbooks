import assert from "node:assert/strict";
import test from "node:test";
import {
  SubscriptionError,
  advanceSubscription,
  monthlyRecurringRevenue,
  normalizeSubscriptionCadence,
  normalizeSubscriptionMoney,
  prorate,
  prorationDocument,
  resolveNextBillOnUpdate,
} from "./subscription-billing.ts";
import { unbilledBoundary } from "./advanced-subscriptions.ts";

test("advanceSubscription steps by interval × count with month-end clamp", () => {
  assert.equal(advanceSubscription("2026-01-15", "monthly", 1), "2026-02-15");
  assert.equal(advanceSubscription("2026-01-31", "monthly", 1), "2026-02-28");
  assert.equal(advanceSubscription("2026-01-10", "monthly", 3), "2026-04-10");
  assert.equal(advanceSubscription("2026-11-30", "quarterly", 1), "2027-02-28");
  assert.equal(advanceSubscription("2026-07-21", "annually", 1), "2027-07-21");
  assert.equal(advanceSubscription("2026-07-21", "weekly", 2), "2026-08-04");
});

test("advanceSubscription pins a stored anchor day instead of drifting", () => {
  assert.equal(advanceSubscription("2026-01-31", "monthly", 1, 31), "2026-02-28");
  // Feb 28 reached from Jan 31 steps to Mar 31 with the anchor, Mar 28 without.
  assert.equal(advanceSubscription("2026-02-28", "monthly", 1, 31), "2026-03-31");
  assert.equal(advanceSubscription("2026-02-28", "monthly", 1), "2026-03-28");
  assert.equal(advanceSubscription("2026-01-31", "quarterly", 1, 31), "2026-04-30");
  assert.equal(advanceSubscription("2028-02-29", "annually", 1, 29), "2029-02-28");
  for (const anchor of [0, 32, 1.5]) {
    assert.throws(
      () => advanceSubscription("2026-01-31", "monthly", 1, anchor),
      /anchor day/,
    );
  }
});

test("monthlyRecurringRevenue normalizes each interval to a monthly figure", () => {
  assert.equal(monthlyRecurringRevenue("100", "monthly", 1, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("100", "monthly", 1, "3"), "300.0000");
  assert.equal(monthlyRecurringRevenue("1200", "annually", 1, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("300", "quarterly", 1, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("300", "monthly", 3, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("100", "weekly", 1, "1"), "433.3333");
});

test("base subscription configuration preserves valid exact decimals and rejects impossible values", () => {
  assert.equal(
    normalizeSubscriptionMoney("999999999999999.9999", "amount", "nonnegative"),
    "999999999999999.9999",
  );
  assert.equal(normalizeSubscriptionMoney("0.0001", "quantity", "positive"), "0.0001");
  assert.deepEqual(normalizeSubscriptionCadence("quarterly", "3"), {
    interval: "quarterly",
    intervalCount: 3,
  });
  assert.equal(monthlyRecurringRevenue("0.1001", "monthly", 1, "3"), "0.3003");

  for (const invalid of ["-0.0001", "1.00001", "1000000000000000"]) {
    assert.throws(
      () => normalizeSubscriptionMoney(invalid, "amount", "nonnegative"),
      SubscriptionError,
    );
  }
  assert.throws(
    () => normalizeSubscriptionMoney("0", "quantity", "positive"),
    /quantity must be greater than zero/,
  );
  assert.throws(() => normalizeSubscriptionCadence("monthly", 0), /positive integer/);
  assert.throws(() => normalizeSubscriptionCadence("monthly", 1.5), /positive integer/);
  assert.throws(() => normalizeSubscriptionCadence("sometimes", 1), /interval must be/);
});

test("billing analytics and period advancement fail closed on residual invalid rows", () => {
  assert.throws(() => advanceSubscription("2026-01-31", "monthly", 0), /positive integer/);
  assert.throws(
    () => monthlyRecurringRevenue("-10", "monthly", 1, "1"),
    /amount must be nonnegative/,
  );
  assert.throws(
    () => monthlyRecurringRevenue("10", "monthly", 1, "0"),
    /quantity must be greater than zero/,
  );
});

test("prorate bills the remaining slice of a period exactly", () => {
  // 30-day period; 10 days elapsed → 20/30 of $300 = $200.
  assert.equal(prorate("300", "2026-06-01", "2026-07-01", "2026-06-11"), "200.0000");
  // Full period remaining.
  assert.equal(prorate("300", "2026-06-01", "2026-07-01", "2026-06-01"), "300.0000");
  // Period already over → nothing remains.
  assert.equal(prorate("300", "2026-06-01", "2026-07-01", "2026-07-05"), "0.0000");
  // Degenerate period → zero, never a divide-by-zero.
  assert.equal(prorate("300", "2026-06-01", "2026-06-01", "2026-06-01"), "0.0000");
});

test("prorate keeps a cross-century billing period positive", () => {
  // dayDiff used Date.UTC, which maps years 0-99 onto 1900-1999: the
  // 0099-12-25..0100-01-07 period read as a NEGATIVE span, prorate returned
  // 0.0000, and the change/first-proration callers skipped the adjustment.
  // 13-day period; nothing elapsed → the full amount.
  assert.equal(prorate("130", "0099-12-25", "0100-01-07", "0099-12-25"), "130.0000");
  // 6 of 13 days remain → 60.
  assert.equal(prorate("130", "0099-12-25", "0100-01-07", "0100-01-01"), "60.0000");
});

test("first-period proration includes all service days from a backdated start", () => {
  // A first invoice is for the complete [startOn, firstBillOn] service period,
  // even when the API is called after a backdated subscription has begun.
  assert.equal(prorate("300", "2026-08-01", "2026-09-01", "2026-08-01"), "300.0000");
  // Service-start anchoring inside prorateFirstInvoice is proven through the
  // real call in subscription-billing-subsidiary.integration.test.ts ("a
  // backdated first invoice charges from service start, not the invocation
  // date").
});

test("prorationDocument maps a signed adjustment to the native document it must become", () => {
  // Downgrade → credit memo carrying the ABSOLUTE amount: credit memos store
  // positive totals (posting.ts credits AR off the positive total; AR reports
  // flip the sign by kind), so a negative amount on an invoice is never right.
  assert.deepEqual(prorationDocument("-75"), { kind: "customer_credit", amount: "75.0000" });
  assert.deepEqual(prorationDocument("-0.0001"), { kind: "customer_credit", amount: "0.0001" });
  // Upgrade → ordinary invoice, unchanged.
  assert.deepEqual(prorationDocument("50"), { kind: "customer_invoice", amount: "50.0000" });
  assert.deepEqual(prorationDocument("0"), { kind: "customer_invoice", amount: "0.0000" });
});

test("billing intervals preserve four-digit early calendar years", () => {
  assert.equal(advanceSubscription("0001-02-15", "monthly"), "0001-03-15");
  assert.equal(advanceSubscription("0099-12-31", "annually"), "0100-12-31");
});

test("the unbilled boundary is the later of the cursor and the latest guard", () => {
  assert.equal(unbilledBoundary("2026-04-01", null), "2026-04-01");
  assert.equal(unbilledBoundary("2026-04-01", "2026-05-01"), "2026-05-01");
  assert.equal(unbilledBoundary("2026-05-01", "2026-04-01"), "2026-05-01");
  assert.equal(unbilledBoundary("2026-04-01", "2026-04-01"), "2026-04-01");
});

test("a next bill date inside the billed window refuses by name", () => {
  // Plain subscription billed for [Mar 1, Apr 1): moving the cursor to Mar 15
  // used to pass the only check (>= current_period_start) and double-bill
  // Mar 15 - Apr 1 under a different guard key.
  assert.throws(
    () => resolveNextBillOnUpdate({
      startOn: "2026-03-01",
      currentPeriodStart: "2026-03-01",
      currentNextBillOn: "2026-04-01",
      guardedThrough: null,
      billed: true,
      newNextBillOn: "2026-03-15",
    }),
    /already-billed service through 2026-04-01/,
  );
});

test("a next bill date exactly on the boundary stays allowed", () => {
  assert.deepEqual(
    resolveNextBillOnUpdate({
      startOn: "2026-03-01",
      currentPeriodStart: "2026-03-01",
      currentNextBillOn: "2026-04-01",
      guardedThrough: null,
      billed: true,
      newNextBillOn: "2026-04-01",
    }),
    { nextBillOn: "2026-04-01", skippedWindow: null },
  );
});

test("a forward jump without an explicit skip refuses by name", () => {
  // Moving the cursor to Jun 1 used to return {ok:true} while Apr-May were
  // never billed.
  for (const input of [
    {
      startOn: "2026-03-01",
      currentPeriodStart: "2026-03-01",
      currentNextBillOn: "2026-04-01",
      guardedThrough: null,
      billed: true,
      newNextBillOn: "2026-06-01",
    },
    {
      startOn: "2026-03-01",
      currentPeriodStart: "2026-03-01",
      currentNextBillOn: "2026-04-01",
      guardedThrough: null,
      billed: true,
      newNextBillOn: "2026-06-01",
      skipUnbilledService: true,
      skipReason: "   ",
    },
  ]) {
    assert.throws(
      () => resolveNextBillOnUpdate(input),
      /skips unbilled service from 2026-04-01 to 2026-06-01.*skipUnbilledService and a skip reason/s,
    );
  }
});

test("a forward jump with a skip reason returns the auditable window", () => {
  assert.deepEqual(
    resolveNextBillOnUpdate({
      startOn: "2026-03-01",
      currentPeriodStart: "2026-03-01",
      currentNextBillOn: "2026-04-01",
      guardedThrough: null,
      billed: true,
      newNextBillOn: "2026-06-01",
      skipUnbilledService: true,
      skipReason: "tenant paused Apr-May",
    }),
    { nextBillOn: "2026-06-01", skippedWindow: { from: "2026-04-01", to: "2026-06-01" } },
  );
});

test("bill-now guards past the cursor extend the boundary a cursor edit must honor", () => {
  const base = {
    startOn: "2026-03-01",
    currentPeriodStart: "2026-03-01",
    currentNextBillOn: "2026-04-01",
    guardedThrough: "2026-05-01",
    billed: true,
  };
  assert.throws(
    () => resolveNextBillOnUpdate({ ...base, newNextBillOn: "2026-04-15" }),
    /already-billed service through 2026-05-01/,
  );
  // Rewriting the current cursor is not a move — it introduces no new overlap.
  assert.deepEqual(
    resolveNextBillOnUpdate({ ...base, newNextBillOn: "2026-04-01" }),
    { nextBillOn: "2026-04-01", skippedWindow: null },
  );
});

test("unbilled subscriptions keep the legacy period check and cannot skip forward silently", () => {
  const base = {
    startOn: "2026-03-01",
    currentPeriodStart: null,
    currentNextBillOn: "2026-03-01",
    guardedThrough: null,
    billed: false,
  };
  assert.throws(
    () => resolveNextBillOnUpdate({ ...base, newNextBillOn: "2026-02-15" }),
    /next bill date cannot precede the subscription period/,
  );
  assert.throws(
    () => resolveNextBillOnUpdate({ ...base, newNextBillOn: "2026-03-10" }),
    /skips unbilled service from 2026-03-01 to 2026-03-10/,
  );
  assert.deepEqual(
    resolveNextBillOnUpdate({
      ...base,
      newNextBillOn: "2026-03-10",
      skipUnbilledService: true,
      skipReason: "customer asked to defer the first bill",
    }),
    { nextBillOn: "2026-03-10", skippedWindow: { from: "2026-03-01", to: "2026-03-10" } },
  );
  assert.throws(
    () => resolveNextBillOnUpdate({ ...base, newNextBillOn: "2026-06-01" }),
    /skips unbilled service from 2026-03-01 to 2026-06-01/,
  );
});
