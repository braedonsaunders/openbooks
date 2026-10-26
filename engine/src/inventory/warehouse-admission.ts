import { sql } from "drizzle-orm";
import type { WarehouseStatus } from "@openbooks/schema";
import { type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { InventoryError, type Runner } from "./contracts.ts";

export type { WarehouseStatus };

/**
 * A named warehouse refusal. It extends InventoryError so every existing
 * `instanceof InventoryError` path (document posting, order conversion,
 * count validation) keeps catching it, and it carries the HTTP status, a
 * stable code and a remedy naming an action that exists, so the route
 * factory can hand all three to the operator.
 */
export class WarehouseRefusal extends InventoryError {
  constructor(
    message: string,
    readonly code: string,
    readonly remedy: string,
    readonly status: 409 | 422 = 409,
  ) {
    super(message);
    this.name = "WarehouseRefusal";
  }
}

const FEATURES_REMEDY =
  "ask an administrator to turn on Warehousing in Company Settings → Features";
export const WAREHOUSES_REMEDY = "Warehouse → Warehouses";

/**
 * Which way stock moves through a location. `count` books a stock count's
 * variance; `revalue` changes the carried value of stock already on hand
 * (landed cost) without moving quantity.
 */
export type StockMovementDirection = "inbound" | "outbound" | "count" | "revalue";

const DIRECTION_LABEL: Record<StockMovementDirection, string> = {
  inbound: "inbound",
  outbound: "outbound",
  count: "count",
  revalue: "revaluation",
};

/**
 * The lifecycle admission table. A draft warehouse is not yet in service and
 * a retired one never returns; a suspended warehouse stops taking stock but
 * may still be drawn down, counted and revalued so it can be emptied.
 */
export function warehouseAdmits(
  status: WarehouseStatus,
  direction: StockMovementDirection,
): boolean {
  if (status === "active") return true;
  if (status === "suspended") return direction !== "inbound";
  return false;
}

/**
 * Lifecycle half of the movement admission check. Reads the warehouse that
 * encloses the location and holds its row FOR SHARE to the caller's commit,
 * so a status change waits for movements in flight and a movement arriving
 * after it re-reads the committed status. A location in no warehouse is
 * admitted exactly as before. The lifecycle holds while the Warehousing
 * feature is off; the remedy then names the switch that brings it back.
 */
export async function assertWarehouseAdmitsMovement(
  tx: Runner,
  orgId: string,
  stockLocationId: string,
  direction: StockMovementDirection,
): Promise<void> {
  const warehouse = (
    await tx.execute<{ code: string; status: WarehouseStatus }>(
      sql`
    select wl.code, w.status
      from warehouses w
      join stock_locations wl on wl.id = w.stock_location_id and wl.org_id = w.org_id
     where w.org_id = ${orgId}
       and w.stock_location_id = stock_location_warehouse(${orgId}::uuid, ${stockLocationId}::uuid)
     for share of w`,
      "objects",
    )
  )[0];
  if (!warehouse || warehouseAdmits(warehouse.status, direction)) return;
  const featureOn = await orgFeatureEnabled(orgId, "warehousing", tx as SqlExecutor);
  const code = warehouse.code;
  let remedy: string;
  if (warehouse.status === "retired") {
    remedy = `a retired warehouse takes no stock; choose another warehouse in ${WAREHOUSES_REMEDY}`;
  } else {
    const verb = warehouse.status === "draft" ? "activate" : "reactivate";
    remedy = featureOn
      ? `${verb} ${code} in ${WAREHOUSES_REMEDY}`
      : `${FEATURES_REMEDY}, then ${verb} ${code}`;
  }
  throw new WarehouseRefusal(
    `warehouse ${code} is ${warehouse.status} and refuses ${DIRECTION_LABEL[direction]} movements; ${remedy}`,
    "warehouse_not_admitting",
    remedy,
  );
}

/**
 * Every warehouse setup function asserts the feature first. Creation holds
 * the feature switchboard row so a concurrent disable serializes against it;
 * lifecycle transitions read it without a lock because they only ever lock
 * the warehouse row, and a movement already holding that row FOR SHARE may
 * go on to lock the organization row at posting.
 *
 * The feature governs multi-location management (warehouse setup, bins,
 * the transfer-order workflow, warehouse-scoped measurement), never the
 * org's single/default stock location: single-location receiving, issuing
 * and production pass through warehouse-scope.ts instead of this gate.
 */
export function warehousingDisabledRefusal(): WarehouseRefusal {
  return new WarehouseRefusal(
    "warehousing is turned off for this organization",
    "warehousing_disabled",
    FEATURES_REMEDY,
  );
}

export async function assertWarehousingFeature(
  runner: Runner,
  orgId: string,
  opts: { lock: boolean } = { lock: false },
): Promise<void> {
  const enabled = opts.lock
    ? await lockAndCheckOrgFeature(runner as SqlExecutor, orgId, "warehousing")
    : await orgFeatureEnabled(orgId, "warehousing", runner as SqlExecutor);
  if (!enabled) {
    throw warehousingDisabledRefusal();
  }
}
