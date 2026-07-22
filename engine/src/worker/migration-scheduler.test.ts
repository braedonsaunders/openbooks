import assert from "node:assert/strict";
import test from "node:test";
import { mirrorIsDue, nextMirrorAt } from "../sync/mirror-schedule.ts";

test("mirror cadence honours labels and cron expressions", () => {
  const from = new Date("2026-07-20T18:22:17.000Z");
  assert.equal(
    nextMirrorAt("hourly", from).toISOString(),
    "2026-07-20T19:22:17.000Z",
  );
  assert.equal(
    nextMirrorAt("daily", from).toISOString(),
    "2026-07-21T18:22:17.000Z",
  );
  assert.equal(
    nextMirrorAt("weekly", from).toISOString(),
    "2026-07-27T18:22:17.000Z",
  );
  assert.equal(
    nextMirrorAt("0 6 * * *", from).toISOString(),
    "2026-07-21T06:00:00.000Z",
  );
  assert.throws(
    () => nextMirrorAt("whenever", from),
    /invalid mirror schedule/,
  );
});

test("failed unrelated work cannot suppress a due mirror", () => {
  assert.equal(
    mirrorIsDue({
      schedule: "daily",
      now: new Date("2026-07-22T14:00:00.000Z"),
      lastSuccessfulAt: new Date("2026-07-20T18:22:17.000Z"),
      lastScheduledAttemptAt: null,
      scheduledFailuresSinceSuccess: 0,
    }),
    true,
  );
});

test("a failed scheduled mirror retries after bounded backoff", () => {
  const base = {
    schedule: "daily",
    lastSuccessfulAt: new Date("2026-07-20T18:22:17.000Z"),
    lastScheduledAttemptAt: new Date("2026-07-22T14:00:00.000Z"),
    scheduledFailuresSinceSuccess: 1,
  };
  assert.equal(
    mirrorIsDue({ ...base, now: new Date("2026-07-22T14:14:59.000Z") }),
    false,
  );
  assert.equal(
    mirrorIsDue({ ...base, now: new Date("2026-07-22T14:15:00.000Z") }),
    true,
  );
});
