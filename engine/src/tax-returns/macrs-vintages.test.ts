import assert from "node:assert/strict";
import test from "node:test";
import { resolveMacrsVintages, type MacrsWorkpaperEvent, type MacrsVintageDefaults } from "./macrs-vintages.ts";

const defaults: MacrsVintageDefaults = {
  recoveryPeriodYears: "7",
  method: "200_db",
  convention: "half_year",
  section179: "1000",
  bonusPercent: "0",
  businessUsePercent: "100",
  shortYearMethod: "simplified",
};

const bothSidedTaxable: MacrsWorkpaperEvent = {
  asset_id: "seller",
  receiving_asset_id: "buyer",
  effective_on: "2025-08-01",
  seller_subsidiary_id: "sub-a",
  buyer_subsidiary_id: "sub-b",
  remaining_basis: "0",
  disposed_unadjusted_basis: "10000.00",
  carryover_basis: null,
  excess_basis: null,
  buyer_cost: "8500.00",
  recognition: "taxable",
  related_person: "true",
  recovery_period_years: "5",
  placed_in_service_on: "2023-03-15",
  macrs_method: "200_db",
  macrs_convention: "half_year",
  short_year_method: "simplified",
  buyer_placed_in_service_on: "2025-08-01",
  buyer_recovery_period_years: "7",
  buyer_method: "200_db",
  buyer_convention: "half_year",
  original_unadjusted_basis: "10000.00",
  section_179: null,
  bonus_percent: null,
  business_use_percent: null,
  prior_depreciation: null,
};

test("a same-regime both-sided taxable transfer starts the buyer on the receiving placed date and class, not seller age", () => {
  const seller = resolveMacrsVintages({
    assetId: "seller",
    subsidiaryId: "sub-a",
    placedOn: "2023-03-15",
    acquisitionCost: "10000.00",
    disposedOn: null,
    papers: [bothSidedTaxable],
    defaults: { ...defaults, recoveryPeriodYears: "5" },
  });
  assert.equal(seller.length, 1);
  assert.equal(seller[0]!.placedInServiceOn, "2023-03-15");
  assert.equal(seller[0]!.recoveryPeriodYears, "5");
  assert.equal(seller[0]!.disposedOn, "2025-08-01");
  assert.equal(seller[0]!.recognition, "taxable");

  const buyer = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2025-08-01",
    acquisitionCost: "8500.00",
    disposedOn: null,
    papers: [bothSidedTaxable],
    defaults,
  });
  assert.equal(buyer.length, 1);
  assert.equal(buyer[0]!.basis, "8500.00");
  assert.equal(buyer[0]!.placedInServiceOn, "2025-08-01");
  assert.equal(buyer[0]!.recoveryPeriodYears, "7");
  assert.equal(buyer[0]!.method, "200_db");
  assert.equal(buyer[0]!.section179, "0");
  assert.equal(buyer[0]!.recognition, "taxable");
  assert.notEqual(buyer[0]!.placedInServiceOn, bothSidedTaxable.placed_in_service_on);
});

test("a taxable buyer schedule comes from frozen computed fields, not a later class edit", () => {
  const buyer = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2026-01-01",
    acquisitionCost: "8500.00",
    disposedOn: null,
    papers: [bothSidedTaxable],
    defaults: {
      ...defaults,
      recoveryPeriodYears: "39",
      method: "straight_line",
      convention: "mid_month",
    },
  });
  assert.equal(buyer[0]!.placedInServiceOn, "2025-08-01");
  assert.equal(buyer[0]!.recoveryPeriodYears, "7");
  assert.equal(buyer[0]!.method, "200_db");
  assert.equal(buyer[0]!.convention, "half_year");
});

test("a taxable receiver without a frozen buyer schedule refuses instead of inheriting seller age", () => {
  assert.throws(
    () =>
      resolveMacrsVintages({
        assetId: "buyer",
        subsidiaryId: "sub-b",
        placedOn: "2025-08-01",
        acquisitionCost: "8500.00",
        disposedOn: null,
        papers: [{
          ...bothSidedTaxable,
          buyer_placed_in_service_on: null,
          buyer_recovery_period_years: null,
          buyer_method: null,
          buyer_convention: null,
        }],
        defaults,
      }),
    (error: unknown) =>
      error instanceof Error && /missing the buyer MACRS schedule/.test(error.message),
  );
});

test("nontaxable carryover keeps transferor history; excess is newly placed on the transfer date", () => {
  const paper: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    recognition: "nontaxable",
    buyer_cost: null,
    carryover_basis: "6400.00",
    excess_basis: "400.00",
    related_person: "false",
    original_unadjusted_basis: "10000.00",
    disposed_unadjusted_basis: "10000.00",
    section_179: "0",
    bonus_percent: "0",
    business_use_percent: "100",
    prior_depreciation: "3600.00",
  };
  const buyer = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2025-08-01",
    acquisitionCost: "6800.00",
    disposedOn: null,
    papers: [paper],
    defaults: { ...defaults, recoveryPeriodYears: "39", method: "straight_line", convention: "mid_month" },
  });
  assert.equal(buyer.length, 2);
  assert.equal(buyer[0]!.basis, "10000.00");
  assert.equal(buyer[0]!.adjustedCarryover, "6400.00");
  assert.equal(buyer[0]!.placedInServiceOn, "2023-03-15");
  assert.equal(buyer[0]!.recoveryPeriodYears, "5");
  assert.equal(buyer[0]!.section179, "0");
  assert.equal(buyer[0]!.priorDepreciation, "3600.00");
  assert.equal(buyer[1]!.placedInServiceOn, "2025-08-01");
  assert.equal(buyer[1]!.recoveryPeriodYears, "7");
  assert.equal(buyer[1]!.method, "200_db");
  assert.equal(buyer[1]!.convention, "half_year");
});

test("two partial disposals in one year keep both disposed portions and the remainder", () => {
  const first: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    receiving_asset_id: null,
    buyer_subsidiary_id: null,
    buyer_cost: null,
    effective_on: "2025-04-01",
    disposed_unadjusted_basis: "2000.00",
    remaining_basis: "8000.00",
  };
  const second: MacrsWorkpaperEvent = {
    ...first,
    effective_on: "2025-09-01",
    disposed_unadjusted_basis: "3000.00",
    remaining_basis: "5000.00",
  };
  const vintages = resolveMacrsVintages({
    assetId: "seller",
    subsidiaryId: "sub-a",
    placedOn: "2023-03-15",
    acquisitionCost: "10000.00",
    disposedOn: null,
    papers: [first, second],
    defaults: { ...defaults, recoveryPeriodYears: "5" },
  });
  const disposed = vintages.filter((vintage) => vintage.disposedOn != null);
  const open = vintages.filter((vintage) => vintage.disposedOn == null);
  assert.equal(disposed.length, 2);
  assert.equal(disposed[0]!.disposedOn, "2025-04-01");
  assert.equal(disposed[1]!.disposedOn, "2025-09-01");
  assert.equal(open.length, 1);
  assert.equal(open[0]!.basis, "5000.0000");
});

test("nontaxable carryover refuses missing allocated transferor elections instead of treating JSON absence as zero", () => {
  assert.throws(
    () =>
      resolveMacrsVintages({
        assetId: "buyer",
        subsidiaryId: "sub-b",
        placedOn: "2025-08-01",
        acquisitionCost: "6400.00",
        disposedOn: null,
        papers: [{
          ...bothSidedTaxable,
          recognition: "nontaxable",
          buyer_cost: null,
          carryover_basis: "6400.00",
          original_unadjusted_basis: "10000.00",
        }],
        defaults,
      }),
    (error: unknown) =>
      error instanceof Error && /missing priorDepreciation/.test(error.message),
  );
});

test("a received asset later disposed does not keep depreciating as acquired", () => {
  const receive: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    effective_on: "2024-06-01",
    buyer_placed_in_service_on: "2024-06-01",
  };
  const onward: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    asset_id: "buyer",
    receiving_asset_id: null,
    seller_subsidiary_id: "sub-b",
    buyer_subsidiary_id: null,
    buyer_cost: null,
    effective_on: "2025-02-01",
    placed_in_service_on: "2024-06-01",
    disposed_unadjusted_basis: "8500.00",
    remaining_basis: "0",
  };
  const vintages = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2026-01-01",
    acquisitionCost: "8500.00",
    disposedOn: null,
    papers: [receive, onward],
    defaults,
  });
  assert.equal(vintages.length, 1);
  assert.equal(vintages[0]!.placedInServiceOn, "2024-06-01");
  assert.equal(vintages[0]!.disposedOn, "2025-02-01");
  assert.equal(vintages[0]!.recognition, "taxable");
});
