import assert from "node:assert/strict";
import test from "node:test";
import { parseLockDates, periodCloser } from "./period-attribution";

const open = {
  runStatus: null,
  runCloserName: null,
  runClosedOn: null,
  lockCloserName: null,
  lockClosedOn: null,
};

test("a closed or published run names the user who closed it", () => {
  const closed = periodCloser({
    ...open,
    runStatus: "closed",
    runCloserName: "Dana Controller",
    runClosedOn: "2026-02-04",
    lockCloserName: "Autopilot",
    lockClosedOn: "2026-02-03",
  });
  assert.deepEqual(closed, { name: "Dana Controller", on: "2026-02-04" });
  const published = periodCloser({
    ...open,
    runStatus: "published",
    runCloserName: "Dana Controller",
    runClosedOn: "2026-02-04",
  });
  assert.deepEqual(published, { name: "Dana Controller", on: "2026-02-04" });
});

test("a period closed by locks alone names the user who took the last lock", () => {
  const byLocks = periodCloser({
    ...open,
    lockCloserName: "Priya Accountant",
    lockClosedOn: "2026-03-31",
  });
  assert.deepEqual(byLocks, { name: "Priya Accountant", on: "2026-03-31" });
});

test("an in-progress run does not name a closer, and an open period names none", () => {
  const inProgress = periodCloser({
    ...open,
    runStatus: "in_progress",
    runCloserName: "Dana",
    runClosedOn: "2026-02-04",
  });
  assert.equal(inProgress, null);
  assert.equal(periodCloser(open), null);
});

test("a closed run without a recorded closer falls back to the lock closer", () => {
  const fallback = periodCloser({
    ...open,
    runStatus: "closed",
    runCloserName: null,
    runClosedOn: "2026-02-04",
    lockCloserName: "Priya Accountant",
    lockClosedOn: "2026-02-03",
  });
  assert.deepEqual(fallback, { name: "Priya Accountant", on: "2026-02-03" });
});

test("lock dates parse per module and skip undated entries", () => {
  const dates = parseLockDates("ar:2026-01-31,ap:2026-01-31,gl:");
  assert.equal(dates.get("ar"), "2026-01-31");
  assert.equal(dates.get("ap"), "2026-01-31");
  assert.equal(dates.has("gl"), false);
  assert.equal(parseLockDates(null).size, 0);
  assert.equal(parseLockDates("").size, 0);
});
