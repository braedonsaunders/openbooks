import assert from "node:assert/strict";
import test from "node:test";
import { fxRateAgeRefusal, FX_RATE_AGE_DEFAULT_DAYS } from "./rate-age-policy.ts";

const limit = { kind: "closing" as const, maxAgeDays: FX_RATE_AGE_DEFAULT_DAYS, effectiveFrom: null };

test("closing rate age accepts the exact inclusive limit and refuses the next day", () => {
  const input = { from: "USD", to: "CAD", rateDate: "2026-03-01", asOf: "2026-04-01", limit };
  assert.equal(fxRateAgeRefusal(input), null);
  const refusal = fxRateAgeRefusal({ ...input, asOf: "2026-04-02" });
  assert.match(refusal!, /USD→CAD/);
  assert.match(refusal!, /2026-03-01, 32 days old/);
  assert.match(refusal!, /31-day limit/);
  assert.match(refusal!, /Setup → Exchange Rates/);
  assert.match(refusal!, /Setup → FX Rate Age Policies/);
});

test("same-day-only policies refuse yesterday's rate and identify their effective version", () => {
  const policy = { kind: "closing" as const, maxAgeDays: 0, effectiveFrom: "2026-07-01" };
  assert.equal(fxRateAgeRefusal({ from: "EUR", to: "CAD", rateDate: "2026-07-31", asOf: "2026-07-31", limit: policy }), null);
  assert.match(fxRateAgeRefusal({ from: "EUR", to: "CAD", rateDate: "2026-07-30", asOf: "2026-07-31", limit: policy })!, /policy effective 2026-07-01/);
});

test("average refusals identify the newest observation included in the period", () => {
  assert.match(fxRateAgeRefusal({ from: "USD", to: "EUR", rateDate: "2026-07-01", asOf: "2026-07-31", limit: { kind: "average", maxAgeDays: 7, effectiveFrom: "2026-01-01" } })!, /spot rate averaged into the period ending 2026-07-31.*30 days old/);
});

test("rate age counts civil days across leap day and year boundaries", () => {
  assert.equal(fxRateAgeRefusal({ from: "USD", to: "CAD", rateDate: "2024-02-28", asOf: "2024-03-01", limit: { ...limit, maxAgeDays: 2 } }), null);
  assert.match(fxRateAgeRefusal({ from: "USD", to: "CAD", rateDate: "2025-12-31", asOf: "2026-01-02", limit: { ...limit, maxAgeDays: 1 } })!, /2 days old/);
});
