import assert from "node:assert/strict";
import test from "node:test";
import {
  carryingAmountForSettlement,
  PaymentError,
  realizedFxControlAdjustment,
} from "./payments.ts";

test("partial settlement allocates carrying value exactly beyond Number's safe range", () => {
  assert.equal(
    carryingAmountForSettlement("900719925474.0991", "300000000000.0000", "100000000000.0000"),
    "300239975158.0330",
  );
});

test("final settlement consumes the exact residual without a rounding tail", () => {
  assert.equal(carryingAmountForSettlement("0.0001", "0.3333", "0.3333"), "0.0001");
  assert.throws(
    () => carryingAmountForSettlement("10", "5", "5.0001"),
    (error: Error) => error instanceof PaymentError,
  );
});

test("realized FX adjustment clears customer and vendor control carrying values", () => {
  // Customer invoice AR +120 settled by receipt AR -130: debit AR 10,
  // credit realized gain 10.
  assert.equal(realizedFxControlAdjustment("-130.0000", "120.0000"), "10.0000");
  // Vendor bill AP -120 settled by payment AP +130: credit AP 10,
  // debit realized loss 10.
  assert.equal(realizedFxControlAdjustment("130.0000", "-120.0000"), "-10.0000");
  assert.equal(realizedFxControlAdjustment("120.0000", "-120.0000"), "0.0000");
});
