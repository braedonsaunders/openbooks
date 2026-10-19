import assert from "node:assert/strict";
import test from "node:test";
import { initialLossOfControlFormState } from "./loss-of-control-form-state";

test("reopening loss-of-control starts with clean values and a fresh request key", () => {
  const state = initialLossOfControlFormState(
    "2026-10-19",
    { investment_account_id: "investment", equity_income_account_id: "income" },
    "new-request-key",
  );

  assert.deepEqual(state.values, {
    effectiveOn: "2026-10-19",
    retainedMethod: "none",
    parentRetainedCarrying: "0",
    retainedPercent: "0",
    retainedFairValue: "0",
    retainedAccountId: "investment",
    equityIncomeAccountId: "income",
  });
  assert.deepEqual(state.rates, {});
  assert.deepEqual(state.oci, []);
  assert.deepEqual(state.adjustments, []);
  assert.equal(state.error, null);
  assert.equal(state.dirty, false);
  assert.equal(state.key, "new-request-key");
});

test("closing loss-of-control clears server defaults as well as edits", () => {
  const state = initialLossOfControlFormState("2026-10-19", null, "next-key");

  assert.deepEqual(state.values, {
    effectiveOn: "2026-10-19",
    retainedMethod: "none",
    parentRetainedCarrying: "0",
    retainedPercent: "0",
    retainedFairValue: "0",
  });
  assert.equal(state.key, "next-key");
});
