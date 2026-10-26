import assert from "node:assert/strict";
import test from "node:test";
import { compareDecimal } from "./exact-decimal";
import { purchaseOrderAmendQuantityFloor } from "./purchase-order-amend-quantity";

test("purchase-order amendment floors preserve cancelled quantity and eight-decimal precision", () => {
  const floor = purchaseOrderAmendQuantityFloor("40.12345678", "39.99999999", "0.00000003");
  assert.equal(floor, "40.12345681");
  assert.equal(compareDecimal("40.12345680", floor), -1);
  assert.equal(compareDecimal("40.12345681", floor), 0);
  assert.equal(
    purchaseOrderAmendQuantityFloor("35.00000000", "45.00000000", "30.00000001"),
    "75.00000001",
  );
});
