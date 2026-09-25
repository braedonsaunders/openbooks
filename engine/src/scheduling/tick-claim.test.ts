import assert from "node:assert/strict";
import test from "node:test";
import { getSchedulerTickHealth, resetSchedulerTickHealth } from "./tick-health.ts";
import { tick } from "./scheduler.ts";

test("a cross-replica claim miss is counted as a skipped tick, never stamped successful", async () => {
  resetSchedulerTickHealth();
  try {
    await tick(async () => null, async () => {});

    const health = getSchedulerTickHealth();
    assert.equal(health.lastTickAt, null, "a pass that did not run must not replace the last completed tick time");
    assert.equal(health.lastTickOk, null, "a lock miss must not publish a successful outcome");
    assert.equal(health.overlapSkips, 1);
    assert.equal(health.consecutiveSkips, 1);
  } finally {
    resetSchedulerTickHealth();
  }
});
