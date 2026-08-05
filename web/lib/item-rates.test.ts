import test from "node:test";
import assert from "node:assert/strict";
import { convertBillRate } from "./item-rate-currency.ts";

test("bill-out FX conversion uses exact four-decimal money arithmetic", () => {
  assert.equal(convertBillRate("102.00", "0.7345678901"), "74.9259");
  assert.equal(convertBillRate("0", "1.5"), "0.0000");
  assert.equal(convertBillRate("155.00", "1"), "155.0000");
});
