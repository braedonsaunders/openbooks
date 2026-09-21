import assert from "node:assert/strict";
import test from "node:test";
import {
  listOpenMacrsVintages,
  macrsVintageDatingPapers,
  macrsVintageReceivingPaper,
  macrsVintageWindowPlan,
  resolveMacrsVintages,
  sellerMacrsHistoryBeforeSource,
  type MacrsWorkpaperEvent,
  type MacrsVintageDefaults,
} from "./macrs-vintages.ts";
import { refreshOpenMacrsVintageThrough } from "./depreciation-pool.ts";
import {
  declaredTaxRegimeFacts,
  validateTaxRegimeBasis,
  type UsMacrsRegimeBasis,
} from "./asset-basis-policy.ts";
import { formatMoney, sum } from "../money/money.ts";

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
  section_168i7_kind: null,
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
  vintage_allocations: null,
  buyer_vintages: null,
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
    section_168i7_kind: "nonrecognition",
    buyer_cost: null,
    carryover_basis: "6400.00",
    excess_basis: "400.00",
    related_person: "false",
    buyer_placed_in_service_on: "2025-09-15",
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
  assert.equal(buyer[1]!.placedInServiceOn, "2025-09-15");
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

test("a partial split allocates section179 to each leg instead of duplicating it", () => {
  const paper: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    receiving_asset_id: null,
    buyer_subsidiary_id: null,
    buyer_cost: null,
    section_179: "200.00",
    disposed_unadjusted_basis: "250.00",
    remaining_basis: "750.00",
    original_unadjusted_basis: "1000.00",
  };
  const vintages = resolveMacrsVintages({
    assetId: "seller",
    subsidiaryId: "sub-a",
    placedOn: "2023-03-15",
    acquisitionCost: "1.00",
    disposedOn: null,
    papers: [paper],
    defaults,
  });
  const disposed = vintages.filter((vintage) => vintage.disposedOn != null);
  const open = vintages.filter((vintage) => vintage.disposedOn == null);
  assert.equal(disposed[0]!.section179, "50.0000");
  assert.equal(open[0]!.section179, "150.0000");
  assert.equal(disposed[0]!.basis, "250.0000");
  assert.equal(open[0]!.basis, "750.0000");
});

test("seller seed consumes frozen statutory basis and vintage, not book cost or class defaults", () => {
  const vintages = resolveMacrsVintages({
    assetId: "seller",
    subsidiaryId: "sub-a",
    placedOn: "2026-01-01",
    acquisitionCost: "1.00",
    disposedOn: null,
    papers: [{
      ...bothSidedTaxable,
      receiving_asset_id: null,
      buyer_subsidiary_id: null,
      buyer_cost: null,
      disposed_unadjusted_basis: "10000.00",
      remaining_basis: "0",
    }],
    defaults: { ...defaults, recoveryPeriodYears: "39", method: "straight_line", convention: "mid_month" },
  });
  assert.equal(vintages[0]!.basis, "10000.0000");
  assert.equal(vintages[0]!.placedInServiceOn, "2023-03-15");
  assert.equal(vintages[0]!.recoveryPeriodYears, "5");
  assert.equal(vintages[0]!.method, "200_db");
  assert.equal(vintages[0]!.convention, "half_year");
});

test("a conflicting remaining declaration is refused instead of overwriting the retained vintage", () => {
  assert.throws(
    () =>
      resolveMacrsVintages({
        assetId: "seller",
        subsidiaryId: "sub-a",
        placedOn: "2023-03-15",
        acquisitionCost: "10000.00",
        disposedOn: null,
        papers: [{
          ...bothSidedTaxable,
          receiving_asset_id: null,
          buyer_subsidiary_id: null,
          buyer_cost: null,
          disposed_unadjusted_basis: "2500.00",
          remaining_basis: "8000.00",
        }],
        defaults: { ...defaults, recoveryPeriodYears: "5" },
      }),
    (error: unknown) =>
      error instanceof Error && /must equal open MACRS basis/.test(error.message),
  );
});

test("a partial across carryover and excess vintages is refused instead of FIFO allocation", () => {
  const receive: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    recognition: "nontaxable",
    section_168i7_kind: "nonrecognition",
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
  const onward: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    asset_id: "buyer",
    receiving_asset_id: null,
    seller_subsidiary_id: "sub-b",
    buyer_subsidiary_id: null,
    buyer_cost: null,
    effective_on: "2025-09-01",
    original_unadjusted_basis: "10400.00",
    placed_in_service_on: "2025-08-01",
    recovery_period_years: "7",
    disposed_unadjusted_basis: "2000.00",
    remaining_basis: "8400.00",
  };
  assert.throws(
    () =>
      resolveMacrsVintages({
        assetId: "buyer",
        subsidiaryId: "sub-b",
        placedOn: "2025-08-01",
        acquisitionCost: "6800.00",
        disposedOn: null,
        papers: [receive, onward],
        defaults,
      }),
    (error: unknown) =>
      error instanceof Error && /does not identify which MACRS vintage/.test(error.message),
  );
});

test("an omitted remaining amount is leftover disposal basis, not a silent full dispose", () => {
  assert.throws(
    () =>
      resolveMacrsVintages({
        assetId: "seller",
        subsidiaryId: "sub-a",
        placedOn: "2023-03-15",
        acquisitionCost: "10000.00",
        disposedOn: null,
        papers: [{
          ...bothSidedTaxable,
          receiving_asset_id: null,
          buyer_subsidiary_id: null,
          buyer_cost: null,
          disposed_unadjusted_basis: "2500.00",
          remaining_basis: null,
        }],
        defaults,
      }),
    (error: unknown) =>
      error instanceof Error && /remaining basis was omitted/.test(error.message),
  );
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
          section_168i7_kind: "nonrecognition",
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

test("an explicit vintage allocation splits carryover and excess without FIFO", () => {
  const receive: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    recognition: "nontaxable",
    section_168i7_kind: "nonrecognition",
    buyer_cost: null,
    carryover_basis: "6200.00",
    excess_basis: "400.00",
    related_person: "true",
    original_unadjusted_basis: "10000.00",
    disposed_unadjusted_basis: "10000.00",
    section_179: "200.00",
    bonus_percent: "0",
    business_use_percent: "100",
    prior_depreciation: "3600.00",
  };
  const onward: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    asset_id: "buyer",
    receiving_asset_id: null,
    seller_subsidiary_id: "sub-b",
    buyer_subsidiary_id: null,
    buyer_cost: null,
    effective_on: "2025-09-01",
    original_unadjusted_basis: "10400.00",
    placed_in_service_on: "2025-08-01",
    recovery_period_years: "7",
    disposed_unadjusted_basis: "2000.00",
    remaining_basis: "8400.00",
    vintage_allocations: [
      {
        source: "carryover",
        placedInServiceOn: "2023-03-15",
        transferOn: "2025-08-01",
        disposedUnadjustedBasis: "2000.00",
        remainingUnadjustedBasis: "8000.00",
      },
      {
        source: "excess",
        placedInServiceOn: "2025-08-01",
        transferOn: "2025-08-01",
        disposedUnadjustedBasis: "0.00",
        remainingUnadjustedBasis: "400.00",
      },
    ],
  };
  const vintages = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2025-08-01",
    acquisitionCost: "6800.00",
    disposedOn: null,
    papers: [receive, onward],
    defaults,
  });
  const open = listOpenMacrsVintages(vintages);
  const disposed = vintages.filter((vintage) => vintage.disposedOn != null);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0]!.source, "carryover");
  assert.equal(disposed[0]!.basis, "2000.0000");
  assert.equal(disposed[0]!.section179, "40.0000");
  assert.equal(disposed[0]!.priorDepreciation, "720.0000");
  assert.deepEqual(open.map((row) => row.key), [
    "carryover:2023-03-15:2025-08-01",
    "excess:2025-08-01:2025-08-01",
  ]);
  assert.equal(open[0]!.unadjustedBasis, "8000.0000");
  assert.equal(open[0]!.section179, "160.0000");
  assert.equal(open[0]!.priorDepreciation, "2880.0000");
  assert.equal(open[1]!.unadjustedBasis, "400.0000");
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

test("seller history before a source distinguishes first declaration from ready vintages and refused history", () => {
  assert.deepEqual(
    sellerMacrsHistoryBeforeSource({
      assetId: "seller",
      subsidiaryId: "sub-a",
      papers: [],
      defaults,
    }),
    { status: "original_declaration_required" },
  );
  assert.throws(
    () =>
      resolveMacrsVintages({
        assetId: "seller",
        subsidiaryId: "sub-a",
        placedOn: "2023-03-15",
        acquisitionCost: "10000.00",
        disposedOn: null,
        papers: [],
        defaults,
        allowBookAcquisition: false,
      }),
    /do not seed book acquisition cost/,
  );
  const missing = sellerMacrsHistoryBeforeSource({
    assetId: "seller",
    subsidiaryId: "sub-a",
    papers: [{ ...bothSidedTaxable, original_unadjusted_basis: null, placed_in_service_on: null }],
    defaults,
  });
  assert.equal(missing.status, "history_refused");
  if (missing.status === "history_refused") {
    assert.match(missing.refusal, /do not substitute book acquisition cost|missing originalUnadjustedBasis|missing placedInServiceOn/);
  }
  const ready = sellerMacrsHistoryBeforeSource({
    assetId: "seller",
    subsidiaryId: "sub-a",
    papers: [{
      ...bothSidedTaxable,
      remaining_basis: "4000.00",
      disposed_unadjusted_basis: "6000.00",
      buyer_cost: null,
      receiving_asset_id: null,
    }],
    defaults,
  });
  assert.equal(ready.status, "ready");
  if (ready.status === "ready") {
    assert.deepEqual(ready.vintages.map((row) => row.key), ["original:2023-03-15"]);
    assert.equal(ready.vintages[0]!.unadjustedBasis, "4000.0000");
    assert.notEqual(ready.vintages[0]!.unadjustedBasis, "10000.00");
  }
  const closed = sellerMacrsHistoryBeforeSource({
    assetId: "seller",
    subsidiaryId: "sub-a",
    papers: [bothSidedTaxable],
    defaults,
  });
  assert.equal(closed.status, "history_refused");
  if (closed.status === "history_refused") {
    assert.match(closed.refusal, /no open MACRS vintage remains/);
  }
  const missingPaper = sellerMacrsHistoryBeforeSource({
    assetId: "seller",
    subsidiaryId: "sub-a",
    papers: [],
    defaults,
    priorSources: [{ key: "change:earlier", occurredOn: "2026-07-01" }],
    paperSourceKeys: [],
  });
  assert.equal(missingPaper.status, "history_refused");
  if (missingPaper.status === "history_refused") {
    assert.match(missingPaper.refusal, /2026-07-01/);
    assert.match(missingPaper.refusal, /do not treat a missing prerequisite paper as a first original declaration/);
  }
});

test("frozen buyer vintages reconstruct two transferor schedules instead of one header composite", () => {
  const paper: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    recognition: "nontaxable",
    section_168i7_kind: "nonrecognition",
    buyer_cost: null,
    carryover_basis: "2000.0000",
    excess_basis: "0",
    related_person: "true",
    original_unadjusted_basis: "10400.00",
    disposed_unadjusted_basis: "2400.00",
    remaining_basis: "8000.00",
    placed_in_service_on: null,
    recovery_period_years: null,
    macrs_method: null,
    macrs_convention: null,
    section_179: "0.0000",
    bonus_percent: "0",
    business_use_percent: "100",
    prior_depreciation: "400.0000",
    buyer_vintages: [
      {
        key: "carryover:2023-03-15:2026-09-01:carryover:2023-03-15:2025-08-01",
        source: "carryover",
        parentKey: "carryover:2023-03-15:2025-08-01",
        placedInServiceOn: "2023-03-15",
        transferOn: "2026-09-01",
        recoveryPeriodYears: "5",
        method: "200_db",
        convention: "half_year",
        unadjustedBasis: "2000.0000",
        adjustedCarryover: "1600.0000",
        section179: "0.0000",
        priorDepreciation: "400.0000",
        bonusPercent: "0",
        businessUsePercent: "100",
        shortYearMethod: "simplified",
        checkpointKind: "declared_elections",
        takenBonus: null,
      },
      {
        key: "carryover:2025-08-01:2026-09-01:excess:2025-08-01:2025-08-01",
        source: "carryover",
        parentKey: "excess:2025-08-01:2025-08-01",
        placedInServiceOn: "2025-08-01",
        transferOn: "2026-09-01",
        recoveryPeriodYears: "7",
        method: "straight_line",
        convention: "mid_month",
        unadjustedBasis: "400.0000",
        adjustedCarryover: "400.0000",
        section179: "0.0000",
        priorDepreciation: "0.0000",
        bonusPercent: "0",
        businessUsePercent: "100",
        shortYearMethod: "allocation",
        checkpointKind: "declared_elections",
        takenBonus: null,
      },
    ],
  };
  const buyer = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2026-09-01",
    acquisitionCost: "1.00",
    disposedOn: null,
    papers: [paper],
    defaults: { ...defaults, recoveryPeriodYears: "39", method: "straight_line", convention: "mid_month" },
  });
  const open = listOpenMacrsVintages(buyer);
  assert.equal(open.length, 2);
  assert.equal(open[0]!.recoveryPeriodYears, "5");
  assert.equal(open[0]!.method, "200_db");
  assert.equal(open[0]!.convention, "half_year");
  assert.equal(open[0]!.parentKey, "carryover:2023-03-15:2025-08-01");
  assert.equal(open[0]!.key, "carryover:2023-03-15:2026-09-01:carryover:2023-03-15:2025-08-01");
  assert.equal(open[1]!.recoveryPeriodYears, "7");
  assert.equal(open[1]!.method, "straight_line");
  assert.equal(open[1]!.convention, "mid_month");
  assert.equal(open[0]!.adjustedCarryover, "1600.0000");
  assert.equal(open[1]!.adjustedCarryover, "400.0000");
  assert.equal(open[0]!.shortYearMethod, "simplified");
  assert.equal(open[1]!.shortYearMethod, "allocation");
});

test("frozen buyer vintages keep their short-year method when the receiving paper header is omitted or simplified", () => {
  const paper: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    recognition: "nontaxable",
    section_168i7_kind: "partnership_721_prior_interest",
    buyer_cost: null,
    carryover_basis: "2000.0000",
    excess_basis: "0",
    related_person: "true",
    original_unadjusted_basis: "10400.00",
    disposed_unadjusted_basis: "2000.00",
    remaining_basis: "8400.00",
    short_year_method: null,
    placed_in_service_on: null,
    recovery_period_years: null,
    macrs_method: null,
    macrs_convention: null,
    section_179: "0.0000",
    bonus_percent: "0",
    business_use_percent: "100",
    prior_depreciation: "400.0000",
    buyer_vintages: [
      {
        key: "carryover:2023-03-15:2026-09-01:original:2023-03-15",
        source: "carryover",
        parentKey: "original:2023-03-15",
        placedInServiceOn: "2023-03-15",
        transferOn: "2026-09-01",
        recoveryPeriodYears: "5",
        method: "200_db",
        convention: "half_year",
        unadjustedBasis: "2000.0000",
        adjustedCarryover: "1600.0000",
        section179: "0.0000",
        priorDepreciation: "400.0000",
        bonusPercent: "0",
        businessUsePercent: "100",
        shortYearMethod: "allocation",
        checkpointKind: "declared_elections",
        takenBonus: null,
      },
    ],
  };
  const buyer = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2026-09-01",
    acquisitionCost: "1.00",
    disposedOn: null,
    papers: [paper],
    defaults,
  });
  assert.equal(buyer.length, 1);
  assert.equal(buyer[0]!.shortYearMethod, "allocation");
  assert.notEqual(buyer[0]!.shortYearMethod, defaults.shortYearMethod);
  assert.equal(buyer[0]!.section168i7Kind, "partnership_721_prior_interest");
  const omittedKind: MacrsWorkpaperEvent = {
    ...paper,
    section_168i7_kind: "nonrecognition",
    short_year_method: "simplified",
  };
  const replayed = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2026-09-01",
    acquisitionCost: "1.00",
    disposedOn: null,
    papers: [omittedKind],
    defaults,
  });
  assert.equal(replayed[0]!.shortYearMethod, "allocation");
  assert.equal(replayed[0]!.section168i7Kind, "nonrecognition");
});

test("same-day transfers to one entity resolve the transferor by receiving asset and parent vintage", () => {
  const buyerA = {
    key: "carryover:2023-03-15:2026-08-20:original:2023-03-15",
    source: "carryover" as const,
    parentKey: "original:2023-03-15",
    placedInServiceOn: "2023-03-15",
    transferOn: "2026-08-20",
    recoveryPeriodYears: "5",
    method: "200_db" as const,
    convention: "half_year" as const,
    unadjustedBasis: "9000.0000",
    adjustedCarryover: "6000.0000",
    section179: "0.0000",
    priorDepreciation: "3000.0000",
    bonusPercent: "0",
    businessUsePercent: "100",
    shortYearMethod: "simplified" as const,
    checkpointKind: "declared_elections" as const,
    takenBonus: null,
  };
  const buyerB = {
    ...buyerA,
    key: "carryover:2022-01-10:2026-08-20:original:2022-01-10",
    parentKey: "original:2022-01-10",
    placedInServiceOn: "2022-01-10",
  };
  const fromA = {
    asset_id: "source-a",
    receiving_asset_id: "recv-a",
    effective_on: "2026-08-20",
    seller_subsidiary_id: "sub-a",
    buyer_vintages: [buyerA],
  };
  const fromB = {
    asset_id: "source-b",
    receiving_asset_id: "recv-b",
    effective_on: "2026-08-20",
    seller_subsidiary_id: "sub-b",
    buyer_vintages: [buyerB],
  };
  const vintageA = {
    source: "carryover" as const,
    placedInServiceOn: "2023-03-15",
    transferOn: "2026-08-20",
    parentKey: "original:2023-03-15",
  };
  const vintageB = {
    source: "carryover" as const,
    placedInServiceOn: "2022-01-10",
    transferOn: "2026-08-20",
    parentKey: "original:2022-01-10",
  };
  assert.equal(macrsVintageReceivingPaper([fromA, fromB], "recv-a", vintageA)?.asset_id, "source-a");
  assert.equal(macrsVintageReceivingPaper([fromA, fromB], "recv-b", vintageB)?.asset_id, "source-b");
  assert.equal(
    macrsVintageWindowPlan({
      assetId: "recv-b",
      currentSubsidiaryId: "buyer-sub",
      asOf: "2026-09-01",
      vintage: vintageB,
      papers: [fromA, fromB],
    }).transferorSubsidiaryId,
    "sub-b",
  );
  assert.notEqual(
    macrsVintageWindowPlan({
      assetId: "recv-b",
      currentSubsidiaryId: "buyer-sub",
      asOf: "2026-09-01",
      vintage: vintageB,
      papers: [fromA, fromB],
    }).transferorSubsidiaryId,
    "sub-a",
  );
});

test("an empty first-declaration taxYearWindows array does not seal later history loads", () => {
  const plan = macrsVintageWindowPlan({
    assetId: "seller",
    currentSubsidiaryId: "sub-a",
    asOf: "2026-08-01",
    vintage: {
      source: "original",
      placedInServiceOn: "2023-01-01",
      transferOn: null,
      parentKey: null,
    },
    papers: [{
      asset_id: "seller",
      receiving_asset_id: "buyer",
      effective_on: "2026-07-01",
      seller_subsidiary_id: "sub-a",
      taxYearWindows: [],
    }],
  });
  assert.deepEqual(plan.frozenSets, []);
  assert.deepEqual(plan.liveLoads, [{
    subsidiaryId: "sub-a",
    fromOn: "2023-01-01",
    throughOn: "2026-08-01",
  }]);
});

test("a present but invalid seller allocation array raises the parser refusal", () => {
  assert.throws(
    () => macrsVintageWindowPlan({
      assetId: "seller",
      currentSubsidiaryId: "sub-a",
      asOf: "2026-08-01",
      vintage: {
        source: "original",
        placedInServiceOn: "2023-01-01",
        transferOn: null,
        parentKey: null,
      },
      papers: [{
        asset_id: "seller",
        receiving_asset_id: "buyer",
        effective_on: "2026-07-01",
        seller_subsidiary_id: "sub-a",
        vintage_allocations: [{ source: "original" }],
      }],
    }),
    /vintageAllocations\[0\]/,
  );
});

test("a present but invalid buyer vintage array raises the parser refusal", () => {
  assert.throws(
    () => macrsVintageReceivingPaper([{
      asset_id: "source-a",
      receiving_asset_id: "recv-a",
      effective_on: "2026-08-20",
      seller_subsidiary_id: "sub-a",
      buyer_vintages: [{ source: "carryover" }],
    }], "recv-a", {
      source: "carryover",
      placedInServiceOn: "2023-03-15",
      transferOn: "2026-08-20",
      parentKey: "original:2023-03-15",
    }),
    /buyerVintages\[0\]/,
  );
});

test("an explicit empty buyer vintage array is not a legacy date match", () => {
  assert.equal(
    macrsVintageReceivingPaper([{
      asset_id: "source-a",
      receiving_asset_id: "recv-a",
      effective_on: "2026-08-20",
      seller_subsidiary_id: "sub-a",
      buyer_vintages: [],
    }], "recv-a", {
      source: "carryover",
      placedInServiceOn: "2023-03-15",
      transferOn: "2026-08-20",
      parentKey: "original:2023-03-15",
    }),
    null,
  );
  assert.equal(
    macrsVintageReceivingPaper([{
      asset_id: "source-a",
      receiving_asset_id: "recv-a",
      effective_on: "2026-08-20",
      seller_subsidiary_id: "sub-a",
    }], "recv-a", {
      source: "carryover",
      placedInServiceOn: "2023-03-15",
      transferOn: "2026-08-20",
      parentKey: "original:2023-03-15",
    })?.asset_id,
    "source-a",
  );
});

test("a present but invalid vintage allocation array raises the parser refusal", () => {
  assert.throws(
    () => macrsVintageDatingPapers([{
      asset_id: "seller",
      receiving_asset_id: "buyer",
      effective_on: "2026-07-01",
      seller_subsidiary_id: "sub-a",
      vintage_allocations: [{ source: "original" }],
    }], "seller", {
      source: "original",
      placedInServiceOn: "2023-01-01",
      transferOn: null,
      parentKey: null,
    }),
    /vintageAllocations\[0\]/,
  );
});

test("a buyer-only declared-elections paper dates later without requiring taken_components on the applied row", () => {
  const validated = validateTaxRegimeBasis(
    {
      regime: "us_macrs",
      relationship: "non_arms_length",
      recognition: "nontaxable",
      relatedPerson: true,
      placedInServiceOn: "2023-03-15",
      recoveryPeriodYears: "5",
      method: "200_db",
      convention: "half_year",
      originalUnadjustedBasis: "10000.00",
      carryoverBasis: "6400.00",
      excessBasis: "0.00",
      section179: "0",
      bonusPercent: "0",
      businessUsePercent: "100",
      priorDepreciation: "3600.00",
      section168i7Kind: "nonrecognition",
    },
    { sourceOperation: "intercompany_transfer", applicable: "buyer" },
  ) as UsMacrsRegimeBasis;
  const persisted = declaredTaxRegimeFacts(validated);
  assert.equal(Object.hasOwn(persisted, "checkpointKind"), false);
  assert.equal(Object.hasOwn(persisted, "takenBonus"), false);
  assert.equal(Object.hasOwn(persisted, "buyerVintages"), false);
  const paper: MacrsWorkpaperEvent = {
    ...bothSidedTaxable,
    recognition: "nontaxable",
    section_168i7_kind: "nonrecognition",
    buyer_cost: null,
    carryover_basis: persisted.carryoverBasis ?? null,
    excess_basis: persisted.excessBasis ?? "0",
    original_unadjusted_basis: persisted.originalUnadjustedBasis ?? null,
    disposed_unadjusted_basis: persisted.originalUnadjustedBasis ?? null,
    remaining_basis: "0",
    placed_in_service_on: persisted.placedInServiceOn ?? null,
    recovery_period_years: persisted.recoveryPeriodYears ?? null,
    macrs_method: persisted.method ?? null,
    macrs_convention: persisted.convention ?? null,
    section_179: persisted.section179 ?? null,
    bonus_percent: persisted.bonusPercent ?? null,
    business_use_percent: persisted.businessUsePercent ?? null,
    prior_depreciation: persisted.priorDepreciation ?? null,
    buyer_vintages: null,
    vintage_allocations: null,
  };
  const received = resolveMacrsVintages({
    assetId: "buyer",
    subsidiaryId: "sub-b",
    placedOn: "2025-08-01",
    acquisitionCost: "1.00",
    disposedOn: null,
    papers: [paper],
    defaults,
  });
  const open = listOpenMacrsVintages(received);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.adjustedCarryover, "6400.00");
  assert.equal(open[0]!.checkpointKind, undefined);
  assert.equal(open[0]!.takenBonus, null);
  const windows = [
    { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
    { taxYear: 2026, yearStart: "2026-01-01", yearEnd: "2026-12-31" },
  ];
  const dated = refreshOpenMacrsVintageThrough(open[0]!, windows, "2026-09-01");
  assert.equal(dated.checkpointKind, "taken_components");
  assert.equal(
    formatMoney(sum([
      dated.section179,
      dated.takenBonus,
      dated.priorDepreciation,
      dated.adjustedCarryover,
    ]), 4),
    "10000.0000",
  );
  const replayed = refreshOpenMacrsVintageThrough(
    listOpenMacrsVintages(resolveMacrsVintages({
      assetId: "buyer",
      subsidiaryId: "sub-b",
      placedOn: "2025-08-01",
      acquisitionCost: "1.00",
      disposedOn: null,
      papers: [paper],
      defaults,
    }))[0]!,
    windows,
    "2026-09-01",
  );
  assert.deepEqual(replayed, dated);
});
