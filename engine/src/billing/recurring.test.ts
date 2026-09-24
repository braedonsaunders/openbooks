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

test("monthly pins a stored anchor day instead of drifting", () => {
  assert.equal(advanceCadence("2026-01-31", "monthly", null, undefined, 31), "2026-02-28");
  // Feb 28 reached from Jan 31 steps to Mar 31 with the anchor, Mar 28 without.
  assert.equal(advanceCadence("2026-02-28", "monthly", null, undefined, 31), "2026-03-31");
  assert.equal(advanceCadence("2026-02-28", "monthly"), "2026-03-28");
  assert.equal(advanceCadence("2026-01-15", "monthly", null, undefined, 15), "2026-02-15");
});

test("monthly rolls the year over at December", () => {
  assert.equal(advanceCadence("2026-12-10", "monthly"), "2027-01-10");
});

test("quarterly and annually advance by 3 and 12 months", () => {
  assert.equal(advanceCadence("2026-07-21", "quarterly"), "2026-10-21");
  assert.equal(advanceCadence("2026-11-30", "quarterly"), "2027-02-28");
  assert.equal(advanceCadence("2028-02-29", "annually"), "2029-02-28");
  assert.equal(advanceCadence("2026-07-21", "annually"), "2027-07-21");
});

test("invalid dates, cadences, and cron rules fail closed", () => {
  assert.throws(() => advanceCadence("2026-07-21", "custom_cron", "not a cron"));
  assert.throws(() => advanceCadence("2026-02-29", "annually"));
  assert.throws(() => advanceCadence("9999-12-31", "monthly"));
  assert.throws(() => advanceCadence("2026-07-21", "unknown" as never));
  assert.equal(advanceCadence("0001-02-28", "monthly"), "0001-03-28");
  assert.equal(advanceCadence("0099-12-28", "weekly"), "0100-01-04");
});

test("midnight cron includes tomorrow and never skips an extra day", () => {
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "0 0 * * *"), "2026-07-22");
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "0 12 * * *"), "2026-07-22");
});

/* Claim/generation atomicity, the failure path, the occurrence guard, both
 * entry points, success bookkeeping, and the schema-level guard are proven
 * through the real scheduler in recurring-dedupe.integration.test.ts: "a
 * tick retrying an already-posted occurrence replays the same document
 * instead of re-posting", "concurrent generations of the same occurrence
 * converge on one document", "a forced lineage failure rolls back the
 * generated document, lines, and lineage together", "occurrence lineage is
 * append-only outside a sandbox wipe", and "occurrence lineage rejects
 * cross-tenant schedule and document references". */

