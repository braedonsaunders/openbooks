import assert from "node:assert/strict";
import test from "node:test";
import {
  getSchedulerTickHealth,
  isSchedulerTickHealthDegraded,
  recordTickDutyFailures,
  recordTickOutcome,
  recordTickOverlapSkip,
  resetSchedulerTickHealth,
  SCHEDULER_OVERLAP_DEGRADED_THRESHOLD,
} from "./tick-health.ts";

/**
 * Behavioural contract for the scheduler tick-health surface (B2-SCH-1,
 * C-56): every overlap skip is counted, a finished tick clears the
 * consecutive run, and failed worker duties are stored beside the counter.
 * Pure in-process recorders — no database, no Redis.
 */

test("an overlap skip counts and lengthens the consecutive run", () => {
  resetSchedulerTickHealth();
  try {
    const first = recordTickOverlapSkip();
    assert.equal(first.overlapSkips, 1);
    assert.equal(first.consecutiveSkips, 1);
    const second = recordTickOverlapSkip();
    assert.equal(second.overlapSkips, 2);
    assert.equal(second.consecutiveSkips, 2);
    assert.equal(getSchedulerTickHealth().overlapSkips, 2);
  } finally {
    resetSchedulerTickHealth();
  }
});

test("a finished tick stamps itself and clears the consecutive run, keeping the lifetime count", () => {
  resetSchedulerTickHealth();
  try {
    recordTickOverlapSkip();
    recordTickOverlapSkip();
    const done = recordTickOutcome(true, new Date("2026-09-24T12:00:00Z"));
    assert.equal(done.lastTickOk, true);
    assert.equal(done.lastTickAt, "2026-09-24T12:00:00.000Z");
    assert.equal(done.consecutiveSkips, 0);
    assert.equal(done.overlapSkips, 2);
    const failed = recordTickOutcome(false);
    assert.equal(failed.lastTickOk, false);
    assert.equal(failed.consecutiveSkips, 0);
  } finally {
    resetSchedulerTickHealth();
  }
});

test("failed worker duties are stored and cleared with the next tick", () => {
  resetSchedulerTickHealth();
  try {
    recordTickDutyFailures([{ key: "automation-tick", error: "boom" }]);
    assert.deepEqual(getSchedulerTickHealth().lastDutyFailures, [{ key: "automation-tick", error: "boom" }]);
    recordTickDutyFailures([]);
    assert.deepEqual(getSchedulerTickHealth().lastDutyFailures, []);
  } finally {
    resetSchedulerTickHealth();
  }
});

test("sustained skips read degraded only at the threshold", () => {
  assert.equal(isSchedulerTickHealthDegraded({ consecutiveSkips: 0 }), false);
  assert.equal(
    isSchedulerTickHealthDegraded({ consecutiveSkips: SCHEDULER_OVERLAP_DEGRADED_THRESHOLD - 1 }),
    false,
  );
  assert.equal(
    isSchedulerTickHealthDegraded({ consecutiveSkips: SCHEDULER_OVERLAP_DEGRADED_THRESHOLD }),
    true,
  );
});
