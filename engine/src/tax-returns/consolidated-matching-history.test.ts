import assert from "node:assert/strict";
import test from "node:test";
import {
  freezeUsConsolidatedMatching,
  matchLiveConsolidatedMacrsYear,
} from "./consolidated-macrs-matching.ts";
import { validateTaxRegimeBasis, usRegimeWorkpaperOutcome } from "./asset-basis-policy.ts";

const seller = "11111111-1111-4111-8111-111111111111";
const buyer = "22222222-2222-4222-8222-222222222222";
const membership = {
  groupKey: "US income-tax group A", sellerSubsidiaryId: seller, buyerSubsidiaryId: buyer,
  effectiveOn: "2023-01-01", throughOn: "2026-12-31",
};
const prior = {
  yearStart: "2025-01-01", yearEnd: "2025-12-31", taxYearWindowId: "window-2025",
  actualDeduction: "15.0000", recomputedDeduction: "10.0000",
};
function match(input: Partial<Parameters<typeof matchLiveConsolidatedMacrsYear>[0]> = {}) {
  return matchLiveConsolidatedMacrsYear({
    computed: freezeUsConsolidatedMatching({ membership, amountRealized: "130.0000", sellerAdjustedBasis: "80.0000" }),
    actualDeduction: "15.0000", recomputedDeduction: "10.0000",
    yearStart: "2026-01-01", yearEnd: "2026-12-31", taxYearWindowId: "window-2026",
    transferOn: "2025-01-01", vintageKey: "carryover:2023-01-01:2025-01-01:original:2023-01-01",
    ...input,
  });
}

test("current-year membership cannot authorize matching in an uncovered prior period", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership: { ...membership, effectiveOn: "2026-01-01" },
    amountRealized: "130.0000", sellerAdjustedBasis: "80.0000",
  });
  assert.throws(() => match({ computed: frozen, priorYears: [prior] }), /membership.*does not cover/i,
    "a previous deduction must not reduce the opening under evidence that begins this year");
});

test("a repeated prior window cannot recognize the same seller matching item twice", () => {
  const once = match({ priorYears: [prior] });
  assert.equal(once.deferredOpening, "45.0000");
  assert.equal(once.deferredClosing, "40.0000");
  assert.throws(() => match({ priorYears: [prior, { ...prior }] }), /duplicate|overlap|already.*year/i,
    "duplicating a prior matching period must refuse instead of silently changing the opening to40");
});

test("different prior identities with overlapping dates cannot both consume deferred gain", () => {
  assert.throws(() => match({ priorYears: [prior, {
    ...prior, taxYearWindowId: "window-overlap", yearStart: "2025-07-01",
  }] }), /overlap/i,
  "different tax-year IDs do not make overlapping corresponding-item periods disjoint");
});

test("deferred opening retains accepted four-decimal sale proceeds before any statutory output rounding", () => {
  const validated = validateTaxRegimeBasis({
    regime: "us_macrs", relationship: "non_arms_length", dispositionTrigger: "sale",
    originalUnadjustedBasis: "100.0000", disposedUnadjustedBasis: "100.0000", remainingUnadjustedBasis: "0",
    placedInServiceOn: "2023-01-01", recoveryPeriodYears: "10", method: "straight_line", convention: "half_year",
    recognition: "taxable", section168i7Kind: "consolidated_group", relatedPerson: true,
    statutoryProceeds: "130.0001", amountRealizedRule: "amount_realized", buyerCost: "130.0001",
    sellerAdjustedBasis: "80.0000", carryoverBasis: "80.0000", excessBasis: "50.0001",
    section179: "0", bonusPercent: "0", businessUsePercent: "100", priorDepreciation: "20.0000",
    consolidatedGroupMembership: membership,
  }, { sourceOperation: "intercompany_transfer", applicable: "both", sellerSubsidiaryId: seller, buyerSubsidiaryId: buyer });
  assert.equal(validated.regime, "us_macrs");
  if (validated.regime !== "us_macrs") return;
  const computed = usRegimeWorkpaperOutcome(validated, "intercompany_transfer", "both", {
    placedInServiceOn: "2025-01-01", recoveryPeriodYears: "10", method: "straight_line", convention: "half_year",
  });
  assert.equal((computed.consolidatedMatching as { deferredOpening: string }).deferredOpening, "50.0001",
    "the accepted0.0001 cannot disappear between declared sale facts and the frozen matching ledger");
});
