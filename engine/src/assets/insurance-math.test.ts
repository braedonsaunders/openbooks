import assert from "node:assert/strict";
import test from "node:test";
import { AssetRefusal } from "./asset-refusal.ts";
import {
  assertCoveragePeriod,
  insuredValueStanding,
  reachedRenewalLeads,
  renewalLadder,
} from "./insurance-math.ts";

function refusedWith(code: string, fn: () => void): void {
  assert.throws(fn, (error: unknown) => error instanceof AssetRefusal && error.code === code);
}

test("the renewal ladder is the policy lead, one week and expiry day, never beyond the lead", () => {
  assert.deepEqual(renewalLadder(30), [30, 7, 0]);
  assert.deepEqual(renewalLadder(7), [7, 0]);
  assert.deepEqual(renewalLadder(3), [3, 0]);
  assert.deepEqual(renewalLadder(0), [0]);
  refusedWith("lead_days_invalid", () => renewalLadder(-1));
  refusedWith("lead_days_invalid", () => renewalLadder(366));
});

test("reached rungs accumulate as expiry approaches so a missed scan catches up", () => {
  assert.deepEqual(reachedRenewalLeads("2026-06-30", "2026-07-31", 30), []);
  assert.deepEqual(reachedRenewalLeads("2026-07-01", "2026-07-31", 30), [30]);
  assert.deepEqual(reachedRenewalLeads("2026-07-25", "2026-07-31", 30), [30, 7]);
  assert.deepEqual(reachedRenewalLeads("2026-08-02", "2026-07-31", 30), [30, 7, 0]);
});

test("insured value is compared with net book value exactly", () => {
  assert.deepEqual(insuredValueStanding("80000", "92500.25"), {
    gap: "-12500.2500",
    standing: "underinsured",
  });
  assert.deepEqual(insuredValueStanding("100000", "92500.25"), {
    gap: "7499.7500",
    standing: "overinsured",
  });
  assert.deepEqual(insuredValueStanding("92500.25", "92500.2500"), {
    gap: "0.0000",
    standing: "matched",
  });
});

test("coverage must end on or after it starts", () => {
  assert.doesNotThrow(() => assertCoveragePeriod("2026-01-01", "2026-01-01"));
  refusedWith("coverage_period_invalid", () => assertCoveragePeriod("2026-01-02", "2026-01-01"));
});
