import test from "node:test";
import assert from "node:assert/strict";
import { beyondCollectibilityHorizon, predictItem, type SettlementStats } from "./cash.ts";

// The cash agent's placement rule with no payment history: the contractual
// due date predicts (a fact), and an item with neither history nor a due
// date is left unplaced — never tranDate + a fabricated 45 days.

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    docKind: "customer_invoice",
    docNumber: "INV-1",
    partyId: "p1",
    partyName: "Customer One",
    tranDate: "2026-09-01",
    dueDate: null,
    remaining: "1200.0000",
    ...overrides,
  };
}

const EMPTY: SettlementStats = { map: new Map(), globalAvg: null };

test("party history predicts from the transaction date with the sigma buffer", () => {
  const stats: SettlementStats = { map: new Map([["p1", { avg: 10, sd: 4 }]]), globalAvg: null };
  // avg 10 + ceil(4 * 0.5) buffer = 12 days after 2026-09-01, before asOf;
  // 2026-09-13 is a Sunday, so the business-day snap lands Monday 09-14.
  assert.deepEqual(predictItem(item({}), "2026-09-05", stats), {
    date: "2026-09-14",
    method: "Statistical",
  });
});

test("a global average still applies when the party has no history", () => {
  const stats: SettlementStats = { map: new Map(), globalAvg: 20 };
  assert.deepEqual(predictItem(item({}), "2026-09-05", stats), {
    date: "2026-09-21",
    method: "Global avg",
  });
});

test("a configured ladder prices through predictItem", () => {
  const stats: SettlementStats = { map: new Map([["p1", { avg: 10, sd: 4 }]]), globalAvg: null };
  // avg 10 + ceil(4 * 1) buffer = 14 days after 2026-09-01 (a Tuesday, so no
  // business-day snap) — the sigma multiple rides the passed model, never a
  // frozen 0.5.
  assert.deepEqual(
    predictItem(item({}), "2026-09-05", stats, {
      settleBufferSigma: 1,
      overduePushShortDays: 7,
      overduePushMidDays: 14,
      overduePushLongDays: 28,
      overdueMidThresholdDays: 30,
      overdueLongThresholdDays: 60,
      collectibilityHorizonDays: 90,
    }),
    { date: "2026-09-15", method: "Statistical" },
  );
});

test("no history anywhere predicts the contractual due date, not tranDate + 45", () => {
  // Old code placed this at tranDate + 45 (2026-10-16); the due date rules.
  assert.deepEqual(predictItem(item({ dueDate: "2026-09-11" }), "2026-09-05", EMPTY), {
    date: "2026-09-11",
    method: "Due date",
  });
});

test("no history and no due date is unplaced rather than invented", () => {
  assert.deepEqual(predictItem(item({}), "2026-09-05", EMPTY), { date: null, method: "Unplaced" });
});

test("a receivable past the collectibility horizon is not projected; credits and payables are not excluded", () => {
  const model = {
    settleBufferSigma: 0.5,
    overduePushShortDays: 7,
    overduePushMidDays: 14,
    overduePushLongDays: 28,
    overdueMidThresholdDays: 30,
    overdueLongThresholdDays: 60,
    collectibilityHorizonDays: 90,
  };
  const stale = item({
    id: "old",
    dueDate: "2025-12-30",
    tranDate: "2025-12-01",
    remaining: "9900.0000",
  });
  assert.equal(beyondCollectibilityHorizon(stale, "2026-10-11", model), true);
  // A balance inside the horizon is still projected.
  const recent = item({
    id: "recent",
    dueDate: "2026-08-12",
    tranDate: "2026-07-01",
    remaining: "250.0000",
  });
  assert.equal(beyondCollectibilityHorizon(recent, "2026-10-11", model), false);
  // Unapplied credits never qualify, however old.
  const credit = item({
    id: "credit",
    dueDate: "2025-12-30",
    tranDate: "2025-12-01",
    remaining: "-400.0000",
  });
  assert.equal(beyondCollectibilityHorizon(credit, "2026-10-11", model), false);
  // No due date ages from the posting date.
  const undated = item({
    id: "undated",
    dueDate: null,
    tranDate: "2025-12-01",
    remaining: "100.0000",
  });
  assert.equal(beyondCollectibilityHorizon(undated, "2026-10-11", model), true);
});
