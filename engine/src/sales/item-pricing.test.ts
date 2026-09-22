import assert from "node:assert/strict";
import test from "node:test";
import { deriveMatrixPrice, selectQuantityPrice } from "./item-pricing.ts";

test("all-units pricing selects the greatest applicable quantity break", () => {
  const breaks = [
    { minimumQuantity: "10", unitPrice: "9.50" },
    { minimumQuantity: "1", unitPrice: "10" },
    { minimumQuantity: "100", unitPrice: "8" },
  ];
  assert.deepEqual(selectQuantityPrice("25", breaks), { minimumQuantity: "10", unitPrice: "9.5000" });
  assert.equal(selectQuantityPrice("0.5", breaks), null);
});

test("quantity pricing refuses ambiguous and invalid grids", () => {
  assert.throws(() => selectQuantityPrice("2", [
    { minimumQuantity: "1", unitPrice: "10" },
    { minimumQuantity: "1.0000", unitPrice: "9" },
  ]), /unique/);
  assert.throws(() => selectQuantityPrice("0", []), /greater than zero/);
  assert.throws(() => selectQuantityPrice("2", [{ minimumQuantity: "1", unitPrice: "-1" }]), /cannot be negative/);
});

test("derived price levels use exact decimal percentage arithmetic", () => {
  assert.equal(deriveMatrixPrice("100", { method: "markup_discount", percentage: "-12.5" }), "87.5000");
  assert.equal(deriveMatrixPrice("80", { method: "cost_plus", percentage: "25" }), "100.0000");
  assert.throws(() => deriveMatrixPrice("10", { method: "markup_discount", percentage: "-110" }), /cannot be negative/);
});
