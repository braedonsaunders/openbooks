import type { db } from "../platform/db.ts";
export interface InventoryAccounts {
  assetAccountId: string;
  cogsAccountId: string;
  adjustmentAccountId: string | null;
  varianceAccountId: string | null;
}

export interface InventoryProfile extends InventoryAccounts {
  itemId: string;
  costingMethod: "fifo" | "moving_average" | "standard";
  tracking: "none" | "lot" | "serial";
  standardCost: string | null;
  baseUnit: string;
  allowNegativeInventory: boolean;
  negativeCostBasis: "last_receipt" | "standard" | "configured";
  provisionalUnitCost: string | null;
}

export class InventoryError extends Error {}

/**
 * The movement would touch stock or a warehouse owned by another legal
 * entity (or a position whose stock belongs to one). The API layer maps this
 * to 403: it is an authorization-boundary refusal, not a validation miss.
 */
export class InventoryOwnershipError extends InventoryError {}

// ---------------------------------------------------------------------------
// Canonical action idempotency boundary
// ---------------------------------------------------------------------------

/**
 * A retry of a direct inventory action is money movement, so a lost response
 * followed by an ordinary client resend must replay the stored result instead
 * of posting a second journal, movement, build, or landed-cost revaluation.
 * Every direct HTTP inventory action threads through this boundary; the key
 * contract is enforced HERE, not at callers:
 *
 *   - missing or malformed key → fail closed (`InventoryError` → HTTP 422);
 *   - same key + same payload, serially or concurrently → the stored result
 *     with `replayed: true` and exactly one accounting unit;
 *   - same key + different payload → `InventoryIdempotencyConflictError`
 *     (mapped to 409 by the API layer);
 *   - a rolled-back attempt burns nothing — the key row shares the command's
 *     transaction and rolls back with it, and a crash after commit replays;
 *   - a rival still in flight is awaited by polling COMMITTED state, never by
 *     pinning a request-pool client (same shape as the web application
 *     boundary over the same `application_idempotency_keys` evidence).
 */
export class InventoryIdempotencyConflictError extends InventoryError {}

export class CostingPolicyChangeBlockedError extends InventoryError {}

export type Runner = Pick<typeof db, "execute">;
