import { strict as assert } from "node:assert";
import { test } from "node:test";
import { periodStartFor } from "./overhead-scheduler.ts";

test("monthly period start", () => {
  assert.equal(periodStartFor("monthly", new Date(Date.UTC(2026, 6, 21))), "2026-07-01");
  assert.equal(periodStartFor("monthly", new Date(Date.UTC(2026, 0, 1))), "2026-01-01");
});

test("quarterly period start snaps to quarter", () => {
  assert.equal(periodStartFor("quarterly", new Date(Date.UTC(2026, 6, 21))), "2026-07-01");
  assert.equal(periodStartFor("quarterly", new Date(Date.UTC(2026, 8, 30))), "2026-07-01");
  assert.equal(periodStartFor("quarterly", new Date(Date.UTC(2026, 11, 31))), "2026-10-01");
  assert.equal(periodStartFor("quarterly", new Date(Date.UTC(2026, 1, 15))), "2026-01-01");
});
