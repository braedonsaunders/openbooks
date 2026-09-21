import assert from "node:assert/strict";
import test from "node:test";
import { prepareTaxBasisRegime } from "./tax-basis-draft";
import {
  validateTaxRegimeBasis,
  type TaxBasisSourceContext,
  type TaxAssetBasisSourceChoice,
  type TaxBasisDraft,
} from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import {
  prepareMacrsVintageAllocations,
  type OpenMacrsVintage,
} from "./macrs-vintage-allocation-draft";

const membershipSource: TaxAssetBasisSourceChoice = {
  key: "transfer", sourceChangeId: "source-change", sourceEventId: null,
  occurredOn: "2026-07-01", sourceKind: "transferred", sourceOperation: "intercompany_transfer",
  bookLabel: "Primary", assetLabel: "FA-101", subsidiaryLabel: "Seller company",
  receivingAssetLabel: "FA-202", receivingSubsidiaryLabel: "Buyer company",
  sellerSubsidiaryId: "11111111-1111-4111-8111-111111111111",
  buyerSubsidiaryId: "22222222-2222-4222-8222-222222222222",
  regimes: [{ code: "us_macrs", name: "United States — MACRS", applicable: "both" }],
  openMacrsVintages: { status: "original_declaration_required" }, appliedWorkpaper: null,
};
const membership = {
  groupKey: "US income-tax group A",
  sellerSubsidiaryId: membershipSource.sellerSubsidiaryId,
  buyerSubsidiaryId: membershipSource.buyerSubsidiaryId!,
  effectiveOn: "2026-01-01", throughOn: "2026-12-31",
};
const membershipContext: TaxBasisSourceContext = {
  sourceOperation: "intercompany_transfer", applicable: "both", effectiveOn: "2026-07-01",
  usSellerMacrs: { status: "original_declaration_required" },
  sellerSubsidiaryId: membershipSource.sellerSubsidiaryId,
  buyerSubsidiaryId: membershipSource.buyerSubsidiaryId,
};
const consolidatedSale: TaxBasisDraft = {
  regime: "us_macrs", relationship: "non_arms_length", dispositionTrigger: "sale",
  originalUnadjustedBasis: "100.0000", disposedUnadjustedBasis: "100.0000", remainingUnadjustedBasis: "0",
  placedInServiceOn: "2024-01-01", recoveryPeriodYears: "10", method: "straight_line", convention: "half_year",
  recognition: "taxable", section168i7Kind: "consolidated_group", relatedPerson: true,
  statutoryProceeds: "130.0000", amountRealizedRule: "amount_realized", buyerCost: "130.0000",
  carryoverBasis: "80.0000", excessBasis: "50.0000", sellerAdjustedBasis: "80.0000",
  section179: "0", bonusPercent: "0", businessUsePercent: "100", priorDepreciation: "20.0000",
  consolidatedGroupMembership: membership,
};

test("native taxable sale retains membership, adjusted basis and independent carryover declarations", () => {
  const post = prepareTaxBasisRegime({
    ...consolidatedSale,
    consolidatedMembership: { ...membership, identity: "invented" },
    consolidatedMatching: { deferredOpening: "0" },
    deferredOpening: "0", sellerMatchingAmount: "999",
  }, membershipContext, undefined, membershipSource);
  assert.equal(post.regime, "us_macrs");
  if (post.regime !== "us_macrs") return;
  assert.deepEqual(post.consolidatedGroupMembership, membership);
  assert.equal(post.recognition, "taxable");
  assert.equal(post.section168i7Kind, "consolidated_group");
  assert.equal(post.sellerAdjustedBasis, "80.0000");
  assert.equal(post.carryoverBasis, "80.0000");
  assert.equal(post.excessBasis, "50.0000");
  const server = validateTaxRegimeBasis(JSON.parse(JSON.stringify(post)), membershipContext);
  assert.equal(server.regime, "us_macrs");
  if (server.regime !== "us_macrs") return;
  assert.deepEqual(server.consolidatedGroupMembership, membership);
  for (const derived of ["consolidatedMembership", "consolidatedMatching", "deferredOpening", "sellerMatchingAmount"])
    assert.equal(Object.hasOwn(post, derived), false, derived);
});

test("membership is not synthesized by a consolidated depreciation election and partial input refuses", () => {
  const absent = prepareTaxBasisRegime({ ...consolidatedSale, consolidatedGroupMembership: undefined },
    membershipContext, undefined, membershipSource);
  assert.equal(Object.hasOwn(absent, "consolidatedGroupMembership"), false);
  assert.throws(() => prepareTaxBasisRegime({ ...consolidatedSale,
    consolidatedGroupMembership: { ...membership, throughOn: "" },
  }, membershipContext, undefined, membershipSource), /missing throughOn/);
  assert.throws(() => prepareTaxBasisRegime({ ...consolidatedSale, sellerAdjustedBasis: "" },
    membershipContext, undefined, membershipSource), /sellerAdjustedBasis/);
});

test("membership never follows a different source or accepts invented nested facts", () => {
  assert.throws(() => prepareTaxBasisRegime(consolidatedSale, membershipContext), /Reload the posted transfer/);
  assert.throws(() => prepareTaxBasisRegime(consolidatedSale, membershipContext, undefined,
    { ...membershipSource, buyerSubsidiaryId: "33333333-3333-4333-8333-333333333333" }), /selected transfer's seller and buyer/);
  assert.throws(() => prepareTaxBasisRegime({ ...consolidatedSale,
    consolidatedGroupMembership: { ...membership, deferredOpening: "0" },
  }, membershipContext, undefined, membershipSource), /unknown consolidatedGroupMembership field/);
  assert.throws(() => prepareTaxBasisRegime({ ...consolidatedSale,
    consolidatedGroupMembership: { ...membership, throughOn: "2025-12-31" },
  }, membershipContext, undefined, membershipSource), /after throughOn/);
});

test("buyer-only taxable carryover survives the native visible-field filter with its required history", () => {
  const context: TaxBasisSourceContext = {
    ...membershipContext, applicable: "buyer", usSellerMacrs: null,
  };
  const source: TaxAssetBasisSourceChoice = {
    ...membershipSource,
    regimes: [{ code: "us_macrs", name: "United States — MACRS", applicable: "buyer" }],
    openMacrsVintages: null,
  };
  const post = prepareTaxBasisRegime(consolidatedSale, context, undefined, source);
  assert.equal(post.regime, "us_macrs");
  if (post.regime !== "us_macrs") return;
  assert.equal(post.originalUnadjustedBasis, "100.0000");
  assert.equal(post.placedInServiceOn, "2024-01-01");
  assert.equal(post.recoveryPeriodYears, "10");
  assert.equal(post.method, "straight_line");
  assert.equal(post.convention, "half_year");
  assert.equal(post.carryoverBasis, "80.0000");
  assert.equal(post.priorDepreciation, "20.0000");
  assert.equal(post.statutoryProceeds, "130.0000");
  assert.equal(Object.hasOwn(post, "disposedUnadjustedBasis"), false);
  assert.equal(Object.hasOwn(post, "remainingUnadjustedBasis"), false);
  const server = validateTaxRegimeBasis(JSON.parse(JSON.stringify(post)), context);
  assert.equal(server.regime, "us_macrs");
  if (server.regime !== "us_macrs") return;
  assert.equal(server.carryoverBasis, "80.0000");
  assert.deepEqual(server.consolidatedGroupMembership, membership);
});

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
