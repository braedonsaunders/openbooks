import assert from "node:assert/strict";
import test from "node:test";
import { costPlusUnitPrice, transferPricingPolicyRefusal } from "./transfer-pricing.ts";
import { extend, perUnit } from "./fulfillment.ts";

const SELLER = "00000000-0000-4000-8000-000000000001";
const BUYER = "00000000-0000-4000-8000-000000000002";
const LEVEL = "00000000-0000-4000-8000-000000000003";

test("cost plus a markup prices exactly to eight decimals", () => {
  assert.equal(costPlusUnitPrice("10", "12.5"), "11.25000000");
  assert.equal(costPlusUnitPrice("0.33333333", "10"), "0.36666666");
  assert.equal(costPlusUnitPrice("19.99", "0"), "19.99000000");
  assert.throws(() => costPlusUnitPrice("-1", "5"), /non-negative/);
  assert.throws(() => costPlusUnitPrice("1", "-5"), /non-negative/);
});

test("a transfer pricing policy names exactly one pricing basis", () => {
  const base = {
    sellerSubsidiaryId: SELLER,
    buyerSubsidiaryId: BUYER,
    effectiveFrom: "2026-01-01",
  };
  assert.equal(
    transferPricingPolicyRefusal({ ...base, method: "cost_plus", markupPercent: "8" }),
    null,
  );
  assert.equal(
    transferPricingPolicyRefusal({ ...base, method: "price_level", priceLevelId: LEVEL }),
    null,
  );
  assert.match(transferPricingPolicyRefusal({ ...base, method: "cost_plus" })!, /markup/);
  assert.match(
    transferPricingPolicyRefusal({
      ...base,
      method: "cost_plus",
      markupPercent: "8",
      priceLevelId: LEVEL,
    })!,
    /clear the price level/,
  );
  assert.match(
    transferPricingPolicyRefusal({
      ...base,
      method: "price_level",
      priceLevelId: LEVEL,
      markupPercent: "8",
    })!,
    /clear the markup/,
  );
  assert.match(transferPricingPolicyRefusal({ ...base, method: "price_level" })!, /price level/);
  assert.match(
    transferPricingPolicyRefusal({ ...base, method: "flat" })!,
    /how transfer prices are set/,
  );
});

test("a subsidiary cannot set transfer prices for sales to itself", () => {
  assert.match(
    transferPricingPolicyRefusal({
      sellerSubsidiaryId: SELLER,
      buyerSubsidiaryId: SELLER,
      method: "cost_plus",
      markupPercent: "1",
      effectiveFrom: "2026-01-01",
    })!,
    /cannot set transfer prices for sales to itself/,
  );
});

test("the policy window must be dated and ordered", () => {
  const base = { sellerSubsidiaryId: SELLER, method: "cost_plus", markupPercent: "1" };
  assert.match(transferPricingPolicyRefusal({ ...base })!, /takes effect/);
  assert.match(
    transferPricingPolicyRefusal({
      ...base,
      effectiveFrom: "2026-02-01",
      effectiveTo: "2026-01-31",
    })!,
    /on or after/,
  );
  assert.equal(
    transferPricingPolicyRefusal({
      ...base,
      effectiveFrom: "2026-02-01",
      effectiveTo: "2026-02-01",
    }),
    null,
  );
  assert.match(
    transferPricingPolicyRefusal({
      ...base,
      markupPercent: "1000.0001",
      effectiveFrom: "2026-01-01",
    })!,
    /between 0 and 1000/,
  );
});

test("transfer amounts extend and divide at ledger precision", () => {
  assert.equal(extend("11.25000000", "3"), "33.7500");
  assert.equal(extend("0.33333333", "3"), "1.0000");
  assert.equal(perUnit("100.0000", "3"), "33.33333333");
  assert.equal(perUnit("-100.0000", "3"), "-33.33333333");
  assert.equal(perUnit("5.0000", "0"), "0");
});
