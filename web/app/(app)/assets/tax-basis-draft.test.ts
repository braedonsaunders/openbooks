import assert from "node:assert/strict";
import test from "node:test";
import { prepareTaxBasisRegime } from "./tax-basis-draft";
import {
  validateTaxRegimeBasis,
  type TaxBasisSourceContext,
} from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
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
    parentKey: null,
    placedInServiceOn: "2023-03-15",
    transferOn: "2025-08-01",
    unadjustedBasis: "10000.0000",
    adjustedCarryover: "8000.0000",
    section179: "0.0000",
    priorDepreciation: "2000.0000",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    bonusPercent: "0",
    businessUsePercent: "100",
    checkpointKind: "declared_elections",
    takenBonus: null,
    shortYearMethod: "allocation",
  },
  {
    key: "excess:2025-08-01:2025-08-01",
    source: "excess",
    parentKey: null,
    placedInServiceOn: "2025-08-01",
    transferOn: "2025-08-01",
    unadjustedBasis: "400.0000",
    adjustedCarryover: null,
    section179: "0.0000",
    priorDepreciation: null,
    recoveryPeriodYears: "7",
    method: "straight_line",
    convention: "mid_month",
    bonusPercent: "0",
    businessUsePercent: "100",
    checkpointKind: "declared_elections",
    takenBonus: null,
    shortYearMethod: "simplified",
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
  const context: TaxBasisSourceContext = {
    sourceOperation: "partial_disposal",
    applicable: "seller",
    usSellerMacrs: { status: "ready", vintages },
  };
  const row = prepareTaxBasisRegime(seller, context, allocations());
  assert.equal(row.regime, "us_macrs");
  if (row.regime !== "us_macrs") return;
  assert.equal(Object.hasOwn(row, "originalUnadjustedBasis"), false);
  const server = validateTaxRegimeBasis(
    JSON.parse(JSON.stringify(row)),
    context,
  );
  assert.equal(server.regime, "us_macrs");
  if (server.regime !== "us_macrs") return;
  assert.equal(server.originalUnadjustedBasis, "10400.0000");
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

test("a native onward-transfer POST contains declarations and the server derives both receiver histories", () => {
  const context: TaxBasisSourceContext = {
    sourceOperation: "intercompany_transfer",
    applicable: "both",
    effectiveOn: "2026-07-01",
    usSellerMacrs: { status: "ready", vintages },
  };
  const allocated = prepareMacrsVintageAllocations(vintages, {
    [vintages[0]!.key]: {
      disposedUnadjustedBasis: "2000",
      remainingUnadjustedBasis: "8000",
    },
    [vintages[1]!.key]: {
      disposedUnadjustedBasis: "100",
      remainingUnadjustedBasis: "300",
    },
  });
  const post = prepareTaxBasisRegime(
    {
      ...seller,
      recognition: "nontaxable",
      section168i7Kind: "nonrecognition",
      relatedPerson: true,
      excessBasis: "0",
    },
    context,
    allocated,
  );
  for (const derived of [
    "buyerVintages",
    "originalUnadjustedBasis",
    "carryoverBasis",
    "placedInServiceOn",
    "method",
    "convention",
    "recoveryPeriodYears",
    "section179",
    "priorDepreciation",
    "bonusPercent",
    "businessUsePercent",
    "sourceOperation",
    "applicable",
    "effectiveOn",
    "usSellerMacrsStatus",
  ])
    assert.equal(Object.hasOwn(post, derived), false, derived);

  // Exercise the actual receiving validator, not a permissive route double.
  const server = validateTaxRegimeBasis(
    JSON.parse(JSON.stringify(post)),
    context,
  );
  assert.equal(server.regime, "us_macrs");
  if (server.regime !== "us_macrs") return;
  assert.equal(server.vintageAllocations?.length, 2);
  assert.equal(server.buyerVintages?.length, 2);
  assert.deepEqual(
    server.buyerVintages?.map((row) => ({
      parent: row.parentKey,
      placed: row.placedInServiceOn,
      method: row.method,
      convention: row.convention,
      recovery: row.recoveryPeriodYears,
      shortYearMethod: row.shortYearMethod,
    })),
    vintages.map((row) => ({
      parent: row.key,
      placed: row.placedInServiceOn,
      method: row.method,
      convention: row.convention,
      recovery: row.recoveryPeriodYears,
      shortYearMethod: row.shortYearMethod,
    })),
  );
  assert.equal(
    Object.hasOwn(server, "method"),
    false,
    "distinct schedules stay distinct",
  );
});

test("a dated checkpoint travels in server context while POST cannot elect or overwrite its taken amounts", () => {
  const dated: OpenMacrsVintage = {
    key: "original:2018-01-05", source: "original", parentKey: null,
    placedInServiceOn: "2018-01-05", transferOn: null,
    unadjustedBasis: "9000.0000", section179: "0.0000", bonusPercent: "100",
    priorDepreciation: "0.0000", adjustedCarryover: "3750.0000",
    checkpointKind: "taken_components", takenBonus: "5250.0000",
    recoveryPeriodYears: "5", method: "200_db", convention: "half_year",
    businessUsePercent: "100", shortYearMethod: "simplified",
  };
  const context: TaxBasisSourceContext = {
    sourceOperation: "intercompany_transfer", applicable: "both", effectiveOn: "2018-08-20",
    usSellerMacrs: { status: "ready", vintages: [dated] },
  };
  const allocation = prepareMacrsVintageAllocations([dated], {
    [dated.key]: { disposedUnadjustedBasis: "9000", remainingUnadjustedBasis: "0" },
  });
  const post = prepareTaxBasisRegime({
    ...seller, recognition: "nontaxable", section168i7Kind: "nonrecognition",
    relatedPerson: true, excessBasis: "0",
    // Neither stale editor state nor an invented client-derived object can
    // become a competing source of approved checkpoint amounts.
    checkpointKind: "declared_elections", takenBonus: "9999.0000",
    buyerVintages: [{ ...dated, takenBonus: "9999.0000" }],
  }, context, allocation);
  for (const derived of ["checkpointKind", "takenBonus", "buyerVintages", "section179", "priorDepreciation"])
    assert.equal(Object.hasOwn(post, derived), false, derived);
  const server = validateTaxRegimeBasis(JSON.parse(JSON.stringify(post)), context);
  assert.equal(server.regime, "us_macrs");
  if (server.regime !== "us_macrs") return;
  assert.deepEqual(server.buyerVintages?.map((row) => ({
    kind: row.checkpointKind, section179: row.section179, bonus: row.takenBonus,
    regular: row.priorDepreciation, remaining: row.adjustedCarryover, method: row.shortYearMethod,
  })), [{
    kind: "taken_components", section179: "0.0000", bonus: "5250.0000",
    regular: "0.0000", remaining: "3750.0000", method: "simplified",
  }]);
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
