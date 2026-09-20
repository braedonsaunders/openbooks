import assert from "node:assert/strict";
import { test } from "node:test";
import {
  measureAssetTransferElimination,
  type AssetTransferBasis,
} from "./asset-transfers.ts";
import { sum } from "../money/money.ts";
const basis: AssetTransferBasis = {
  groupCost: "1000",
  groupAccumulated: "400",
  groupSalvage: "0",
  groupPlan: [
    { startsOn: "2026-08-01", date: "2026-08-31", amount: "300" },
    { startsOn: "2026-09-01", date: "2026-09-30", amount: "300" },
  ],
  buyerCost: "900",
  buyerToGroupRate: "1",
  ctaAccountId: "cta",
  groupAssetAccountId: "asset",
  groupAccumulatedAccountId: "accum",
  groupDepreciationAccountId: "depreciation",
  groupGainLossAccountId: "gain",
  taxRatePercent: "25",
  deferredTaxAccountId: "tax_asset",
  taxExpenseAccountId: "tax_expense",
};
test("intercompany transfer restores historical gross basis and eliminates internal profit with deferred tax", () => {
  const r = measureAssetTransferElimination(basis, {
    asOf: "2026-07-31",
    buyerCost: "900",
    buyerAccumulated: "0",
    remainingFraction: { numerator: 1n, denominator: 1n },
    disposed: false,
  });
  assert.equal(r.asset, "100.0000");
  assert.equal(r.accum, "-400.0000");
  assert.equal(r.gain, "300.0000");
  assert.equal(r.tax_asset, "75.0000");
  assert.equal(sum(Object.values(r)), "0.0000");
});
test("excess buyer depreciation is released against the retained group plan", () => {
  const r = measureAssetTransferElimination(basis, {
    asOf: "2026-08-31",
    buyerCost: "900",
    buyerAccumulated: "450",
    remainingFraction: { numerator: 1n, denominator: 1n },
    disposed: false,
  });
  assert.equal(r.accum, "-250.0000");
  assert.equal(r.depreciation, "-150.0000");
  assert.equal(r.tax_asset, "37.5000");
  assert.equal(sum(Object.values(r)), "0.0000");
});
test("external disposal releases the entire remaining profit and deferred tax", () => {
  const r = measureAssetTransferElimination(basis, {
    asOf: "2026-08-31",
    buyerCost: "900",
    buyerAccumulated: "450",
    remainingFraction: { numerator: 1n, denominator: 1n },
    disposed: true,
    depreciationAdjustment: "-150",
    realizedMargin: "150",
  });
  assert.equal(r.asset, "0.0000");
  assert.equal(r.accum, "0.0000");
  assert.equal(r.gain, "150.0000");
  assert.equal(r.depreciation, "-150.0000");
  assert.equal(r.tax_asset, "0.0000");
  assert.equal(sum(Object.values(r)), "0.0000");
});
test("partial disposal retains only the physical share still in the group", () => {
  const r = measureAssetTransferElimination(basis, {
    asOf: "2026-08-31",
    buyerCost: "450",
    buyerAccumulated: "225",
    remainingFraction: { numerator: 1n, denominator: 2n },
    disposed: false,
    depreciationAdjustment: "-150",
    realizedMargin: "75",
  });
  assert.equal(r.gain, "225.0000");
  assert.equal(r.tax_asset, "18.7500");
  assert.equal(sum(Object.values(r)), "0.0000");
});

test("foreign-operation balance adjustments use closing rates while translation differences remain in OCI", () => {
  const r = measureAssetTransferElimination(basis, {
    asOf: "2026-08-31",
    buyerCost: "900",
    buyerAccumulated: "450",
    remainingFraction: { numerator: 1n, denominator: 1n },
    disposed: false,
    currentBuyerRate: "1.2",
    depreciationAdjustment: "-165",
  });
  assert.equal(r.asset, "120.0000");
  assert.equal(r.accum, "-300.0000");
  assert.equal(r.depreciation, "-165.0000");
  assert.equal(r.tax_asset, "45.0000");
  assert.equal(r.tax_expense, "-33.7500");
  assert.equal(r.cta, "33.7500");
  assert.equal(sum(Object.values(r)), "0.0000");
});

test("upstream internal profit reduces the seller NCI allocation, net of deferred tax", () => {
  const r = measureAssetTransferElimination(
    {
      ...basis,
      nci: {
        percent: "20",
        equityAccountId: "nci",
        incomeAccountId: "nci_income",
      },
    },
    {
      asOf: "2026-07-31",
      buyerCost: "900",
      buyerAccumulated: "0",
      remainingFraction: { numerator: 1n, denominator: 1n },
      disposed: false,
    },
  );
  assert.equal(r.nci, "45.0000");
  assert.equal(r.nci_income, "-45.0000");
  assert.equal(sum(Object.values(r)), "0.0000");
});
test("correcting the underlying transfer reverses the entire target rather than realizing profit", () => {
  const r = measureAssetTransferElimination(basis, {
    asOf: "2026-07-31",
    buyerCost: "900",
    buyerAccumulated: "0",
    remainingFraction: { numerator: 1n, denominator: 1n },
    disposed: false,
    reversed: true,
  });
  assert.deepEqual(r, {});
});

test("legal impairment is eliminated only to the independently measured group extent", () => {
  const r = measureAssetTransferElimination(basis, {
    asOf: "2026-08-31",
    buyerCost: "900",
    buyerAccumulated: "550",
    remainingFraction: { numerator: 1n, denominator: 1n },
    disposed: false,
    groupAccumulatedDelta: "50",
    valuationAdjustment: "-50",
    depreciationAdjustment: "-150",
  });
  assert.equal(r.accum, "-200.0000");
  assert.equal(r.gain, "250.0000");
  assert.equal(r.depreciation, "-150.0000");
  assert.equal(r.tax_asset, "25.0000");
  assert.equal(r.cta, "0.0000");
  assert.equal(sum(Object.values(r)), "0.0000");
});
