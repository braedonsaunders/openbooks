import assert from "node:assert/strict";
import test from "node:test";
import { periodLockBlocksPosting } from "./close.ts";

const now = new Date("2026-07-20T12:00:00Z");

test("historical replay bypasses only source-imported period locks", () => {
  assert.equal(periodLockBlocksPosting({
    state: "closed",
    reopenExpiresAt: null,
    reason: "close.importedPeriodLockReason",
  }, false, now), true);
  assert.equal(periodLockBlocksPosting({
    state: "closed",
    reopenExpiresAt: null,
    reason: "close.importedPeriodLockReason",
  }, true, now), false);
  assert.equal(periodLockBlocksPosting({
    state: "closed",
    reopenExpiresAt: null,
    reason: "controller_close",
  }, true, now), true);
});

test("expired temporary reopening closes again", () => {
  assert.equal(periodLockBlocksPosting({
    state: "open",
    reopenExpiresAt: "2026-07-20T11:59:59Z",
    reason: "controller_reopen",
  }, false, now), true);
  assert.equal(periodLockBlocksPosting({
    state: "open",
    reopenExpiresAt: "2026-07-20T12:00:01Z",
    reason: "controller_reopen",
  }, false, now), false);
});
