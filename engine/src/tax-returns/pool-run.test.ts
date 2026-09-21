import assert from "node:assert/strict";
import test from "node:test";
import { add, formatMoney } from "../money/money.ts";
import { matchConsolidatedDepreciation } from "./consolidated-tax-matching.ts";
import {
  freezeUsConsolidatedMatching,
  matchConsolidatedMacrsFromWorkpaper,
} from "./consolidated-macrs-matching.ts";
import { computeMacrsThroughYear } from "./depreciation-pool.ts";
import { matchConsolidatedGroupPaperYear, type ConsolidatedMatchingPaper } from "./pool-run.ts";
import { legacyPoolDisposition, taxEventRequiresTaxWorkpaper } from "./pool-run-legacy.ts";
import type { MacrsVintage } from "./macrs-vintages.ts";

const MEMBERSHIP = {
  groupKey: "example-4-group",
  sellerSubsidiaryId: "00000000-0000-4000-8000-000000000001",
  buyerSubsidiaryId: "00000000-0000-4000-8000-000000000002",
  effectiveOn: "2023-01-01",
  throughOn: "2026-12-31",
};

test("legacy ordinary disposals do not require a tax workpaper", () => {
  assert.equal(taxEventRequiresTaxWorkpaper("disposed", null), false);
  assert.equal(taxEventRequiresTaxWorkpaper("written_off", null), false);
  assert.equal(taxEventRequiresTaxWorkpaper("disposed", undefined), false);
});

test("native governed lifecycle events require an approved tax workpaper", () => {
  const changeId = "00000000-0000-4000-8000-000000000001";
  assert.equal(taxEventRequiresTaxWorkpaper("disposed", changeId), true);
  assert.equal(taxEventRequiresTaxWorkpaper("written_off", changeId), true);
  assert.equal(taxEventRequiresTaxWorkpaper("partially_disposed", null), true);
  assert.equal(taxEventRequiresTaxWorkpaper("partially_disposed", changeId), true);
  assert.equal(taxEventRequiresTaxWorkpaper("transferred", null), true);
  assert.equal(taxEventRequiresTaxWorkpaper("transferred", changeId), true);
});

test("pool-run matching is the native helper from the frozen Example 4 opening", () => {
  const frozen = freezeUsConsolidatedMatching({
    membership: MEMBERSHIP,
    amountRealized: "130.00",
    sellerAdjustedBasis: "80.00",
  });
  const result = matchConsolidatedMacrsFromWorkpaper({
    role: "buyer",
    computed: frozen,
    originalUnadjustedBasis: "10000.0000",
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    taxYearWindowId: "window-2025",
    vintageKey: "carryover:2023-01-01:2025-08-20:original:2023-01-01",
    transferOn: "2025-08-20",
    allocatedDeferredOpening: "50.0000",
    sellerSubsidiaryId: MEMBERSHIP.sellerSubsidiaryId,
    buyerSubsidiaryId: MEMBERSHIP.buyerSubsidiaryId,
  });
  const expected = matchConsolidatedDepreciation({
    deferredOpening: "50.0000",
    actualDeduction: "15.0000",
    recomputedDeduction: "10.0000",
  });
  assert.ok(result);
  assert.equal(result.deferredOpening, "50.0000");
  assert.equal(result.sellerMatchingAmount, expected.sellerMatchingAmount);
  assert.notEqual(result.actualDeduction, result.recomputedDeduction);
});

test("pool-run matching does not invent membership from a §168(i)(7) sale without the nest", () => {
  assert.equal(
    matchConsolidatedMacrsFromWorkpaper({
      role: "buyer",
      computed: { recognition: "taxable", section168i7Kind: "consolidated_group" },
      originalUnadjustedBasis: "10000.0000",
      actualDeduction: "15.0000",
      recomputedDeduction: "10.0000",
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
    }),
    null,
  );
});

const WINDOWS = [
  { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31" },
  { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
  { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
];

const RUN = {
  taxYear: 2025,
  yearStart: "2025-01-01",
  yearEnd: "2025-12-31",
  taxYearWindowId: "00000000-0000-4000-8000-000000000025",
  shortYearFactor: "1",
};

function matchingPaper(originalUnadjustedBasis: string): ConsolidatedMatchingPaper {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    computed: freezeUsConsolidatedMatching({
      membership: MEMBERSHIP,
      amountRealized: "130.00",
      sellerAdjustedBasis: "80.00",
    }),
    original_unadjusted_basis: originalUnadjustedBasis,
    seller_subsidiary_id: MEMBERSHIP.sellerSubsidiaryId,
    buyer_subsidiary_id: MEMBERSHIP.buyerSubsidiaryId,
  };
}

function buyerVintage(args: {
  source: MacrsVintage["source"];
  basis: string;
  placedInServiceOn: string;
  transferOn: string;
  parentKey: string | null;
  adjustedCarryover?: string | null;
}): MacrsVintage {
  return {
    basis: args.basis,
    placedInServiceOn: args.placedInServiceOn,
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    disposedOn: null,
    section179: "0",
    bonusPercent: "0",
    businessUsePercent: "100",
    shortYearMethod: "simplified",
    role: "buyer",
    transferOn: args.transferOn,
    recognition: "taxable",
    section168i7Kind: "consolidated_group",
    adjustedCarryover: args.adjustedCarryover ?? null,
    priorDepreciation: null,
    source: args.source,
    parentKey: args.parentKey,
    takenBonus: null,
  };
}

function sellerStillHeld(basis: string, placedInServiceOn: string): string {
  return computeMacrsThroughYear({
    basis,
    placedInServiceOn,
    taxYear: 2025,
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, WINDOWS).current.allowance;
}

test("runTaxPool matching grain walks one seller schedule per carryover and allocates the paper opening", () => {
  const carryover = buyerVintage({
    source: "carryover",
    basis: "100.0000",
    placedInServiceOn: "2023-01-01",
    transferOn: "2025-08-20",
    parentKey: "original:2023-01-01",
    adjustedCarryover: "80.0000",
  });
  const excess = buyerVintage({
    source: "excess",
    basis: "50.0000",
    placedInServiceOn: "2025-08-20",
    transferOn: "2025-08-20",
    parentKey: null,
  });
  const actualCarryover = computeMacrsThroughYear({
    basis: carryover.basis,
    placedInServiceOn: carryover.placedInServiceOn,
    taxYear: 2025,
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    adjustedCarryover: carryover.adjustedCarryover ?? undefined,
    carryoverOn: carryover.transferOn ?? undefined,
    section168i7Kind: "consolidated_group",
  }, WINDOWS).current.allowance;
  const actualExcess = computeMacrsThroughYear({
    basis: excess.basis,
    placedInServiceOn: excess.placedInServiceOn,
    taxYear: 2025,
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, WINDOWS).current.allowance;
  const results = matchConsolidatedGroupPaperYear({
    paper: matchingPaper("100.0000"),
    jobs: [
      { vintage: carryover, actualAllowance: actualCarryover, sellerLineage: WINDOWS, buyerReportingWindows: WINDOWS },
      { vintage: excess, actualAllowance: actualExcess, sellerLineage: WINDOWS, buyerReportingWindows: WINDOWS },
    ],
    run: RUN,
  });
  assert.equal(results.length, 2);
  const carry = results.find((row) => row.vintage.source === "carryover")!;
  const extra = results.find((row) => row.vintage.source === "excess")!;
  const trueRecomputed = sellerStillHeld("100.0000", "2023-01-01");
  const doubled = formatMoney(add(trueRecomputed, trueRecomputed), 2);
  assert.equal(carry.matched.recomputedDeduction, trueRecomputed);
  assert.equal(extra.matched.recomputedDeduction, "0.00");
  assert.notEqual(formatMoney(add(carry.matched.recomputedDeduction, extra.matched.recomputedDeduction), 2), doubled);
  assert.equal(
    formatMoney(add(carry.matched.deferredOpening, extra.matched.deferredOpening), 4),
    "50.0000",
  );
  assert.notEqual(carry.matched.deferredOpening, "50.0000");
  assert.notEqual(extra.matched.deferredOpening, "50.0000");
  assert.equal(carry.matched.actualDeduction, actualCarryover);
  assert.equal(extra.matched.actualDeduction, actualExcess);
});

test("runTaxPool matching grain walks each two-parent carryover from that parent slice, not paper original", () => {
  const parentA = buyerVintage({
    source: "carryover",
    basis: "60.0000",
    placedInServiceOn: "2023-01-01",
    transferOn: "2025-07-01",
    parentKey: "original:2023-01-01",
    adjustedCarryover: "48.0000",
  });
  const parentB = buyerVintage({
    source: "carryover",
    basis: "40.0000",
    placedInServiceOn: "2024-01-01",
    transferOn: "2025-07-01",
    parentKey: "original:2024-01-01",
    adjustedCarryover: "32.0000",
  });
  const results = matchConsolidatedGroupPaperYear({
    paper: matchingPaper("100.0000"),
    jobs: [
      { vintage: parentA, actualAllowance: "10.00", sellerLineage: WINDOWS, buyerReportingWindows: WINDOWS },
      { vintage: parentB, actualAllowance: "8.00", sellerLineage: WINDOWS, buyerReportingWindows: WINDOWS },
    ],
    run: RUN,
  });
  assert.equal(results.length, 2);
  const first = results.find((row) => row.vintage.parentKey === "original:2023-01-01")!;
  const second = results.find((row) => row.vintage.parentKey === "original:2024-01-01")!;
  assert.equal(first.matched.recomputedDeduction, sellerStillHeld("60.0000", "2023-01-01"));
  assert.equal(second.matched.recomputedDeduction, sellerStillHeld("40.0000", "2024-01-01"));
  assert.notEqual(first.matched.recomputedDeduction, sellerStillHeld("100.0000", "2023-01-01"));
  assert.notEqual(second.matched.recomputedDeduction, sellerStillHeld("100.0000", "2024-01-01"));
  assert.equal(
    formatMoney(add(first.matched.deferredOpening, second.matched.deferredOpening), 4),
    "50.0000",
  );
  assert.equal(first.matched.deferredOpening, "30.0000");
  assert.equal(second.matched.deferredOpening, "20.0000");
});

test("paper-year matching aggregates disposed and retained slices of one receiving vintage", () => {
  const carryover = buyerVintage({
    source: "carryover",
    basis: "60.0000",
    placedInServiceOn: "2023-01-01",
    transferOn: "2025-08-20",
    parentKey: "original:2023-01-01",
    adjustedCarryover: "48.0000",
  });
  const disposed = {
    ...carryover,
    basis: "40.0000",
    disposedOn: "2025-10-01",
    adjustedCarryover: "32.0000",
  };
  const results = matchConsolidatedGroupPaperYear({
    paper: matchingPaper("100.0000"),
    jobs: [
      { vintage: carryover, actualAllowance: "6.00", sellerLineage: WINDOWS, buyerReportingWindows: WINDOWS },
      { vintage: disposed, actualAllowance: "4.00", sellerLineage: WINDOWS, buyerReportingWindows: WINDOWS },
    ],
    run: RUN,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.vintageKey, "carryover:2023-01-01:2025-08-20:original:2023-01-01");
  assert.equal(results[0]!.matched.actualDeduction, "10.00");
  assert.equal(results[0]!.matched.recomputedDeduction, sellerStillHeld("100.0000", "2023-01-01"));
  assert.equal(results[0]!.matched.deferredOpening, "50.0000");
});

test("seller-still-held recomputed uses the buyer reporting interval over original recovery years", () => {
  const sellerYears = [
    { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31", subsidiaryId: MEMBERSHIP.sellerSubsidiaryId },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31", subsidiaryId: MEMBERSHIP.sellerSubsidiaryId },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31", subsidiaryId: MEMBERSHIP.sellerSubsidiaryId },
  ];
  const buyerYear = [{
    taxYear: 2026,
    yearStart: "2025-07-01",
    yearEnd: "2026-06-30",
    subsidiaryId: MEMBERSHIP.buyerSubsidiaryId,
  }];
  const carryover = buyerVintage({
    source: "carryover",
    basis: "100.0000",
    placedInServiceOn: "2023-01-01",
    transferOn: "2025-08-20",
    parentKey: "original:2023-01-01",
    adjustedCarryover: "80.0000",
  });
  const results = matchConsolidatedGroupPaperYear({
    paper: matchingPaper("100.0000"),
    jobs: [{
      vintage: carryover,
      actualAllowance: "15.00",
      sellerLineage: [...sellerYears, ...buyerYear],
      buyerReportingWindows: buyerYear,
    }],
    run: {
      taxYear: 2026,
      yearStart: "2025-07-01",
      yearEnd: "2026-06-30",
      taxYearWindowId: "00000000-0000-4000-8000-000000000026",
      shortYearFactor: "1",
    },
  });
  assert.equal(results.length, 1);
  assert.notEqual(results[0]!.matched.recomputedDeduction, "0.00");
  assert.equal(results[0]!.matched.yearStart, "2025-07-01");
  assert.equal(results[0]!.matched.yearEnd, "2026-06-30");
});

test("legacy pool disposition is the lesser of proceeds and the capital-cost cap", () => {
  assert.equal(legacyPoolDisposition("60000.00", "37000.00"), "37000.00");
  assert.equal(legacyPoolDisposition("20000.00", "37000.00"), "20000.00");
  assert.equal(legacyPoolDisposition("37000.00", "37000.00"), "37000.00");
  assert.equal(legacyPoolDisposition(null, "37000.00"), "0");
  assert.equal(legacyPoolDisposition(undefined, "37000.00"), "0");
});
