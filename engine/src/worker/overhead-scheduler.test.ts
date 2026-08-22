import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { periodStartFor } from "./overhead-scheduler.ts";

const schedulerSource = readFileSync(new URL("./overhead-scheduler.ts", import.meta.url), "utf8");

test("monthly period start", () => {
  assert.equal(periodStartFor("monthly", "2026-07-21"), "2026-07-01");
  assert.equal(periodStartFor("monthly", "2026-01-01"), "2026-01-01");
});

test("quarterly period start snaps to quarter", () => {
  assert.equal(periodStartFor("quarterly", "2026-07-21"), "2026-07-01");
  assert.equal(periodStartFor("quarterly", "2026-09-30"), "2026-07-01");
  assert.equal(periodStartFor("quarterly", "2026-12-31"), "2026-10-01");
  assert.equal(periodStartFor("quarterly", "2026-02-15"), "2026-01-01");
});

test("overhead ticks snap the period to the org calendar day, not a UTC Date", () => {
  assert.match(
    schedulerSource,
    /const today = await businessToday\(org\.id\);[\s\S]*?periodStartFor\(cadence, today\)/,
  );
  assert.match(
    schedulerSource,
    /return cadence === "quarterly" \? calendarQuarterBounds\(today\)\.start : startOfMonth\(today\)/,
  );
  assert.doesNotMatch(schedulerSource, /Date\.UTC/);
  assert.doesNotMatch(schedulerSource, /toISOString\(\)\.slice\(0,\s*10\)/);
});
