import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryError,
  InventoryIdempotencyConflictError,
  InventoryOwnershipError,
} from "@openbooks/engine/src/inventory/contracts.ts";
import { inventoryErrorStatus } from "./inventory-errors.ts";

test("inventory refusals map to their HTTP status", () => {
  assert.equal(inventoryErrorStatus(new InventoryOwnershipError("cross-entity")), 403);
  assert.equal(inventoryErrorStatus(new InventoryIdempotencyConflictError("key reuse")), 409);
  assert.equal(inventoryErrorStatus(new InventoryError("validation miss")), 422);
  assert.equal(inventoryErrorStatus(new Error("boom")), 500);
  assert.equal(inventoryErrorStatus("boom"), 500);
});
