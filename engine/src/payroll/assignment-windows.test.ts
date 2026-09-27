import assert from "node:assert/strict";
import test from "node:test";
import { assignmentCoveredDays, assignmentCoversPeriod } from "./assignment-windows.ts";

test("a fixed assignment starting mid-period in a cross-century period prorates over 14 days", () => {
  const window = {
    effectiveFrom: "0100-01-01",
    effectiveTo: null,
    periodStart: "0099-12-25",
    periodEnd: "0100-01-07",
  };
  // Covers 01-01..01-07 (7 days) of a 14-day period — the line pays 7/14 of
  // the fixed amount instead of being silently dropped.
  assert.deepEqual(assignmentCoveredDays(window), { coveredDays: 7, periodDays: 14 });
  assert.equal(assignmentCoversPeriod(window), false);
});

test("a fully-covering cross-century assignment still pays in full", () => {
  const window = {
    effectiveFrom: "0099-12-25",
    effectiveTo: null,
    periodStart: "0099-12-25",
    periodEnd: "0100-01-07",
  };
  assert.deepEqual(assignmentCoveredDays(window), { coveredDays: 14, periodDays: 14 });
  assert.equal(assignmentCoversPeriod(window), true);
});
