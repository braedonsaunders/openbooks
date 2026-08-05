import assert from "node:assert/strict";
import test from "node:test";
import { advanceCadence } from "./recurring.ts";

test("weekly and biweekly step by exact day counts", () => {
  assert.equal(advanceCadence("2026-07-21", "weekly"), "2026-07-28");
  assert.equal(advanceCadence("2026-07-21", "biweekly"), "2026-08-04");
});

test("monthly clamps a month-end anchor to shorter months", () => {
  assert.equal(advanceCadence("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(advanceCadence("2028-01-31", "monthly"), "2028-02-29"); // leap year
  assert.equal(advanceCadence("2026-01-15", "monthly"), "2026-02-15");
});

test("monthly rolls the year over at December", () => {
  assert.equal(advanceCadence("2026-12-10", "monthly"), "2027-01-10");
});

test("quarterly and annually advance by 3 and 12 months", () => {
  assert.equal(advanceCadence("2026-07-21", "quarterly"), "2026-10-21");
  assert.equal(advanceCadence("2026-11-30", "quarterly"), "2027-02-28");
  assert.equal(advanceCadence("2026-02-29" /* not real, still clamps */, "annually"), "2027-02-28");
  assert.equal(advanceCadence("2026-07-21", "annually"), "2027-07-21");
});

test("a malformed custom cron falls back to a monthly step instead of looping", () => {
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "not a cron"), "2026-08-21");
});
