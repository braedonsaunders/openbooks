import assert from "node:assert/strict";
import test from "node:test";
import {
  assetPlacementMissingFields,
  type AssetPlacementAsset,
  type AssetPlacementCategory,
  type AssetPlacementPolicy,
} from "./placement-readiness.ts";

const CATEGORY: AssetPlacementCategory = {
  defaultMethod: "straight_line",
  defaultDepreciationMethodId: null,
  defaultLifeMonths: null,
};

function complete(overrides: Partial<AssetPlacementAsset> = {}): AssetPlacementAsset {
  return {
    acquisitionCost: "12000.0000",
    inServiceOn: "2026-01-15",
    depreciationMethod: "straight_line",
    depreciationMethodId: null,
    usefulLifeMonths: 48,
    depreciationUnitsTotal: null,
    openingAccumulated: null,
    openingAsOf: null,
    ...overrides,
  };
}

function missing(
  asset: AssetPlacementAsset,
  options: { category?: AssetPlacementCategory | null; policy?: AssetPlacementPolicy | null } = {},
) {
  return assetPlacementMissingFields({
    asset,
    category: options.category === undefined ? CATEGORY : options.category,
    policy: options.policy ?? null,
  });
}

test("a complete straight-line draft has nothing missing", () => {
  assert.deepEqual(missing(complete()), []);
});

test("a complete draft with an opening-as-of pair is ready to place in service", () => {
  assert.deepEqual(
    missing(complete({ openingAccumulated: "3000.0000", openingAsOf: "2025-12-31" })),
    [],
  );
});

test("a blank or zero cost is named as missing, never treated as set", () => {
  assert.deepEqual(missing(complete({ acquisitionCost: null })), ["acquisition_cost"]);
  assert.deepEqual(missing(complete({ acquisitionCost: "" })), ["acquisition_cost"]);
  assert.deepEqual(missing(complete({ acquisitionCost: "0.0000" })), ["acquisition_cost"]);
});

test("a missing in-service date is the only field named when everything else is set", () => {
  assert.deepEqual(missing(complete({ inServiceOn: null })), ["in_service_on"]);
});

test("a straight-line asset needs a useful life unless the category or book policy supplies one", () => {
  assert.deepEqual(missing(complete({ usefulLifeMonths: null })), ["useful_life_months"]);
  assert.deepEqual(
    missing(complete({ usefulLifeMonths: null }), {
      category: { ...CATEGORY, defaultLifeMonths: 60 },
    }),
    [],
    "the category default life is the effective life the build uses",
  );
  assert.deepEqual(
    missing(complete({ usefulLifeMonths: null }), {
      policy: {
        method: "straight_line",
        depreciationMethodId: null,
        lifeMonths: 36,
        unitsTotal: null,
      },
    }),
    [],
    "a primary-book policy life overrides the asset",
  );
});

test("manual depreciation needs no useful life, but a tenant formula always does", () => {
  assert.deepEqual(missing(complete({ depreciationMethod: "manual", usefulLifeMonths: null })), []);
  assert.deepEqual(
    missing(
      complete({
        depreciationMethodId: "11111111-1111-4111-8111-111111111111",
        usefulLifeMonths: null,
      }),
    ),
    ["useful_life_months"],
  );
});

test("units-of-production requires positive expected lifetime units", () => {
  const units = complete({ depreciationMethod: "units_of_production", usefulLifeMonths: null });
  assert.deepEqual(missing({ ...units, depreciationUnitsTotal: null }), [
    "depreciation_units_total",
  ]);
  assert.deepEqual(missing({ ...units, depreciationUnitsTotal: "0" }), [
    "depreciation_units_total",
  ]);
  assert.deepEqual(missing({ ...units, depreciationUnitsTotal: "50000" }), []);
});

test("an opening amount and its as-of date are both-or-neither", () => {
  assert.deepEqual(missing(complete({ openingAccumulated: "3000.0000", openingAsOf: null })), [
    "opening_accumulated_as_of",
  ]);
  assert.deepEqual(missing(complete({ openingAccumulated: null, openingAsOf: "2025-12-31" })), [
    "opening_accumulated_depreciation",
  ]);
});

test("a missing category is named as missing", () => {
  assert.deepEqual(missing(complete(), { category: null }), ["category_id"]);
});

test("several gaps are named in form order", () => {
  assert.deepEqual(
    missing(complete({ acquisitionCost: null, inServiceOn: null, usefulLifeMonths: null })),
    ["acquisition_cost", "in_service_on", "useful_life_months"],
  );
});
