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

test("database-wire timestamp strings are accepted by the mirror scheduler", () => {
  assert.equal(
    mirrorIsDue({
      schedule: "daily",
      now: new Date("2026-07-22T15:00:00.000Z"),
      lastSuccessfulAt: "2026-07-20T18:22:17.627Z",
      lastScheduledAttemptAt: null,
      scheduledFailuresSinceSuccess: 0,
    }),
    true,
  );
});

test("one org's enqueue failure is recorded by name while the remaining orgs still enqueue (C-57)", async () => {
  const { enqueueDueMirrors } = await import("./migration-worker.ts");
  const now = new Date("2026-07-22T15:00:00.000Z");
  const candidate = (id: string, orgId: string) => ({
    id,
    orgId,
    schedule: "hourly",
    lastSuccessfulAt: null,
    lastScheduledAttemptAt: null,
    scheduledFailuresSinceSuccess: 0,
  });
  const enqueued: string[] = [];
  const outcome = await enqueueDueMirrors(
    [candidate("conn-a", "org-a"), candidate("conn-b", "org-b"), candidate("conn-c", "org-c")],
    (async (data: { connectionId: string }) => {
      if (data.connectionId === "conn-b") throw new Error("Redis unavailable for org-b");
      enqueued.push(data.connectionId);
      return undefined as never;
    }) as never,
    now,
  );
  assert.equal(outcome.attempted, 3);
  assert.deepEqual(outcome.orgErrors, [
    { orgId: "org-b", connectionId: "conn-b", error: "Redis unavailable for org-b" },
  ]);
  assert.deepEqual(enqueued, ["conn-a", "conn-c"]);
});
