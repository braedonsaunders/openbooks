import test from "node:test";
import assert from "node:assert/strict";
import { predictItem, type SettlementStats } from "./cash.ts";

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
  assert.deepEqual(predictItem(item({}), "2026-09-05", stats), { date: "2026-09-14", method: "Statistical" });
});

test("a global average still applies when the party has no history", () => {
  const stats: SettlementStats = { map: new Map(), globalAvg: 20 };
  assert.deepEqual(predictItem(item({}), "2026-09-05", stats), { date: "2026-09-21", method: "Global avg" });
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
