import type { db } from "../platform/db.ts";
export type { SqlExecutor } from "../platform/db.ts";
export interface InventoryAccounts {
  assetAccountId: string;
  cogsAccountId: string;
  adjustmentAccountId: string | null;
  varianceAccountId: string | null;
}

export interface InventoryProfile extends InventoryAccounts {
  itemId: string;
  costingMethod: "fifo" | "moving_average" | "standard";
  tracking: "none" | "lot" | "serial" | "lot_serial";
  standardCost: string | null;
  baseUnit: string;
  unitConversions?: Record<string, number>;
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
/**
 * A receipt without a unit cost found no average to carry it at. Callers that
 * collect costs (stock counts) catch it to name their own remedy.
 */
export class InventoryCostBasisError extends InventoryError {
  constructor(
    message: string,
    readonly itemLabel: string,
  ) {
    super(message);
  }
}
/** A record is absent or outside the actor's organization/subsidiary scope. */
export class InventoryNotFoundError extends InventoryError {}

/**
 * A receipt movement's cost layers carry live downstream consumption. The
 * void path catches this to name each dependent and its native reverse
 * path instead of refusing with the kernel sentence alone.
 */
export class DownstreamConsumptionError extends InventoryError {
  constructor(
    message: string,
    readonly movementId: string,
  ) {
    super(message);
    this.name = "DownstreamConsumptionError";
  }
}

/** Machine-readable code for a movement refused until its unit gains a conversion row. */
export const ITEM_MISSING_UNIT_CONVERSION = "ITEM_MISSING_UNIT_CONVERSION";

/**
 * A line raised in a unit the item cannot convert to its base unit. The
 * message names the remedy that exists (raise the line in the base unit, or
 * add the conversion under Unit conversions on the item's Inventory costing
 * section); `details` carries the machine-readable item identity the
 * document drawer offers as a link to that section.
 */
export class UnitConversionError extends InventoryError {
  readonly code = ITEM_MISSING_UNIT_CONVERSION;
  readonly status = 422;
  constructor(
    message: string,
    readonly details: {
      itemId: string | null;
      itemName: string | null;
      unit: string;
      baseUnit: string;
    },
  ) {
    super(message);
    this.name = "UnitConversionError";
  }
}

/** Machine-readable code for a vendor bill refused until its stocked lines are matched to their purchase-order lines. */
export const BILL_LINES_UNMATCHED = "BILL_LINES_UNMATCHED";

/**
 * A vendor-bill line hand-coded for receipt-tracked stock while an approved
 * purchase order still holds that item open for billing. The message names
 * the order to match (by document number, never an internal id); `remedy`
 * carries the operator's next step and `details` the machine-readable
 * line and order numbers the bill drawer offers as a Match action.
 */
export class BillLinesUnmatchedError extends InventoryError {
  readonly code = BILL_LINES_UNMATCHED;
  constructor(
    message: string,
    readonly remedy: string,
    readonly details: {
      lineNumber: number;
      itemCode: string | null;
      purchaseOrderNumbers: string[];
    },
  ) {
    super(message);
    this.name = "BillLinesUnmatchedError";
  }
}

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
