import assert from "node:assert/strict";
import test from "node:test";
import { prepareTaxBasisRegime } from "./tax-basis-draft";
import {
  prepareMacrsVintageAllocations,
  type OpenMacrsVintage,
} from "./macrs-vintage-allocation-draft";

const seller = {
  regime: "us_macrs",
  relationship: "arms_length",
  dispositionTrigger: "sale",
  originalUnadjustedBasis: "10400.00",
  remainingUnadjustedBasis: "stale header",
  disposedUnadjustedBasis: "stale header",
  placedInServiceOn: "2023-03-15",
  recoveryPeriodYears: "5",
  method: "200_db",
  convention: "half_year",
  recognition: "taxable",
  relatedPerson: false,
  statutoryProceeds: "0.00",
  amountRealizedRule: "amount_realized",
};
const vintages: OpenMacrsVintage[] = [
  {
    key: "carryover:2023-03-15:2025-08-01",
    source: "carryover",
    placedInServiceOn: "2023-03-15",
    transferOn: "2025-08-01",
    unadjustedBasis: "10000.0000",
    adjustedCarryover: "8000.0000",
    section179: "0.0000",
    priorDepreciation: "2000.0000",
  },
  {
    key: "excess:2025-08-01:2025-08-01",
    source: "excess",
    placedInServiceOn: "2025-08-01",
    transferOn: "2025-08-01",
    unadjustedBasis: "400.0000",
    adjustedCarryover: null,
    section179: "0.0000",
    priorDepreciation: null,
  },
];
const allocations = () =>
  prepareMacrsVintageAllocations(vintages, {
    [vintages[0]!.key]: {
      disposedUnadjustedBasis: "2000",
      remainingUnadjustedBasis: "8000",
    },
    [vintages[1]!.key]: {
      disposedUnadjustedBasis: "0",
      remainingUnadjustedBasis: "400",
    },
  });

test("POST carries nested allocation identities and exact sums through the real policy validator", () => {
  const row = prepareTaxBasisRegime(
    {
      ...seller,
      buyerCost: "not applicable",
      partialDispositionElection: false,
    },
    { sourceOperation: "partial_disposal", applicable: "seller" },
    allocations(),
  );
  assert.equal(row.regime, "us_macrs");
  if (row.regime !== "us_macrs") return;
  assert.equal(row.disposedUnadjustedBasis, "2000.0000");
  assert.equal(row.remainingUnadjustedBasis, "8400.0000");
  assert.equal(row.vintageAllocations?.length, 2);
  assert.equal(row.vintageAllocations?.[1]!.source, "excess");
  assert.equal(row.vintageAllocations?.[1]!.disposedUnadjustedBasis, "0.0000");
  assert.equal(row.relatedPerson, false);
  assert.equal(row.statutoryProceeds, "0.00");
  for (const hidden of [
    "buyerCost",
    "partialDispositionElection",
    "sourceOperation",
    "applicable",
  ])
    assert.equal(Object.hasOwn(row, hidden), false, hidden);
});

test("a source's buyer-only context cannot receive seller allocation rows", () => {
  assert.throws(
    () =>
      prepareTaxBasisRegime(
        { ...seller, buyerCost: "5000" },
        { sourceOperation: "intercompany_transfer", applicable: "buyer" },
        allocations(),
      ),
    /belong to the seller/,
  );
});

test("changing a CA allocation choice removes the old fact while preserving zero proceeds", () => {
  const row = prepareTaxBasisRegime(
    {
      regime: "ca_cca",
      relationship: "arms_length",
      allocationMethod: "ascertainable_fraction",
      originalCapitalCost: "3000",
      allocationFraction: "0.25",
      allocatedCapitalCost: "stale",
      statutoryProceeds: "0.00",
      rolloverElection: "none",
    },
    { sourceOperation: "partial_disposal", applicable: "seller" },
  );
  assert.equal(row.regime, "ca_cca");
  if (row.regime !== "ca_cca") return;
  assert.equal(row.statutoryProceeds, "0.00");
  assert.equal(row.allocationFraction, "0.25");
  assert.equal(Object.hasOwn(row, "allocatedCapitalCost"), false);
});

test("ready history supplies total basis and discards stale composite seller fields", () => {
  const row = prepareTaxBasisRegime(
    seller,
    {
      sourceOperation: "partial_disposal",
      applicable: "seller",
      usSellerMacrs: { status: "ready", vintages },
    },
    allocations(),
  );
  assert.equal(row.regime, "us_macrs");
  if (row.regime !== "us_macrs") return;
  assert.equal(row.originalUnadjustedBasis, "10400.0000");
  assert.equal(row.vintageAllocations?.length, 2);
  for (const hidden of [
    "placedInServiceOn",
    "recoveryPeriodYears",
    "method",
    "convention",
    "usSellerMacrsStatus",
  ])
    assert.equal(Object.hasOwn(row, hidden), false, hidden);
});

test("a server history refusal reaches the proposal action unchanged", () => {
  const refusal =
    "The earlier transfer has no approved US workpaper. Apply its statutory basis workpaper before allocating this disposal.";
  assert.throws(
    () =>
      prepareTaxBasisRegime(seller, {
        sourceOperation: "partial_disposal",
        applicable: "seller",
        usSellerMacrs: { status: "history_refused", refusal },
      }),
    (error: unknown) => error instanceof Error && error.message === refusal,
  );
});
