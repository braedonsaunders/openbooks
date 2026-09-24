import {
  InventoryError,
  InventoryIdempotencyConflictError,
  InventoryOwnershipError,
} from "@openbooks/engine/src/inventory/contracts.ts";

/**
 * The single inventory error-to-HTTP-status mapping shared by every
 * inventory route. A cross-entity ownership refusal is an
 * authorization-boundary failure (403), never a validation miss (422);
 * idempotency-key reuse with different input is a conflict (409).
 */
export function inventoryErrorStatus(error: unknown): number {
  if (error instanceof InventoryOwnershipError) return 403;
  if (error instanceof InventoryIdempotencyConflictError) return 409;
  if (error instanceof InventoryError) return 422;
  return 500;
}
