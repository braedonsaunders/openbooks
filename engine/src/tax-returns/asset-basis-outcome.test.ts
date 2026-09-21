import assert from "node:assert/strict";
import test from "node:test";
import { validateTaxRegimeBasis, type NzPoolRegimeBasis } from "./asset-basis-policy.ts";
import { computeTaxRegimeOutcome } from "./asset-basis-workpaper.ts";

test("NZ associated-person equivalent rate is frozen on the buyer outcome", () => {
  const row = validateTaxRegimeBasis({
    regime: "nz_pool",
    relationship: "non_arms_length",
    sourceOperation: "intercompany_transfer",
    applicable: "both",
    consideration: "100.00",
    disposalExpenditure: "0",
    buyerPrice: "80.00",
    associatedPersonCostBasis: "original_cost",
    associatedPersonOriginalCost: "90.00",
    associatedPersonEquivalentRate: "0.08",
    commissionerActualCost: false,
    consolidatingGroupAtv: false,
  }) as NzPoolRegimeBasis;
  const computed = computeTaxRegimeOutcome(row, "intercompany_transfer", "both");
  assert.equal(computed.associatedPersonEquivalentRate, "0.0800000000");
  assert.equal(computed.buyerDepreciationCost, "80.00");
});
