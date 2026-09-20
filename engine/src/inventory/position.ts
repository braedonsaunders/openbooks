import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits, isZero, normalizeMoney, sum, toUnits } from "../money/money.ts";
import { unitCostPerQuantity } from "./costing.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { InventoryError, type Runner } from "./contracts.ts";

export function persistReceiptMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new InventoryError(`${label} must be an exact decimal`);
  let amount: string;
  try {
    amount = normalizeMoney(exact);
  } catch {
    throw new InventoryError(`${label} must be an exact decimal`);
  }
  // Every caller lands in numeric(19,4) columns (movements, order lines,
  // landed costs): fifteen whole digits. A pasted wider figure normalized
  // fine and died only at the insert with a storage error — fail closed
  // here, once, for receipts, issues, transfers, builds, and landed costs.
  if (amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new InventoryError(`${label} is out of range — at most 15 whole digits fit the ledger`);
  }
  return amount;
}

/** Primary accounting book id. */
export async function primaryBookId(
  orgId: string,
  runner: Runner = db,
): Promise<string> {
  const r = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl limit 1 for share`));
  if (!r.rows[0]) throw new InventoryError("no active primary posting book");
  return r.rows[0].id;
}

export async function periodForDate(
  orgId: string,
  date: string,
  runner: Runner = db,
): Promise<string | null> {
  const r = (await runner.execute<{ id: string }>(sql`
    select id from accounting_periods
     where org_id = ${orgId} and is_adjustment = false and starts_on <= ${date} and ends_on >= ${date}
     limit 1`));
  return r.rows[0]?.id ?? null;
}

export async function subsidiaryCurrency(
  orgId: string,
  subsidiaryId: string,
  runner: Runner = db,
): Promise<string> {
  const r = (await runner.execute<{ base_currency: string }>(sql`
    select base_currency from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}`));
  if (!r.rows[0]) throw new InventoryError("subsidiary not found");
  return r.rows[0].base_currency;
}

/** Current on-hand quantity and value for an item at a location (from layers). */
export async function getOnHand(
  orgId: string,
  itemId: string,
  stockLocationId: string,
): Promise<{ quantity: string; value: string; unitCost: string }> {
  return getOnHandWith(db, orgId, itemId, stockLocationId);
}

/**
 * On-hand quantity and value for ONE legal entity's layers at a position.
 * Revaluation measures each owner separately so a shared warehouse's other
 * entities never feed another's carrying-amount math.
 */
export async function getOnHandForEntity(
  runner: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  subsidiaryId: string,
): Promise<{ quantity: string; value: string; unitCost: string }> {
  return getOnHandWith(runner, orgId, itemId, stockLocationId, { subsidiaryId });
}

export async function getOnHandWith(
  runner: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  selection: {
    lotId?: string | null;
    serialId?: string | null;
    /** Restrict availability to layers created by one originating receipt. */
    sourceReceiptMovementId?: string | null;
    /** Count only layers owned by this entity; omit to span the position. */
    subsidiaryId?: string;
  } = {},
): Promise<{ quantity: string; value: string; unitCost: string }> {
  const lotId = selection.lotId ?? null;
  const serialId = selection.serialId ?? null;
  const sourceReceiptMovementId = selection.sourceReceiptMovementId ?? null;
  const subId = selection.subsidiaryId ?? null;
  // Layer sums are scoped per legal entity so one subsidiary's availability,
  // and the average cost a receipt inherits, can never be driven by another
  // entity's stock sharing the same warehouse.
  const layerScope = subId ? sql`and cost_layers.subsidiary_id = ${subId}` : sql``;
  const provisionalScope = subId
    ? sql`and exists (
            select 1 from inventory_movements owner_mv
             where owner_mv.id = inventory_provisional_costs.issue_movement_id
               and owner_mv.org_id = ${orgId}
               and owner_mv.subsidiary_id = ${subId})`
    : sql``;
  const r = (await runner.execute<{ quantity: string; value: string }>(sql`
    select (coalesce((select sum(remaining_quantity) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                         ${layerScope}
                         and (${sourceReceiptMovementId}::uuid is null or source_movement_id = ${sourceReceiptMovementId}::uuid)
                         and (${lotId}::uuid is null and ${serialId}::uuid is null
                              or exists (
                                select 1 from inventory_movements source
                                 where source.id = cost_layers.source_movement_id
                                   and source.org_id = ${orgId}
                                   and (${lotId}::uuid is null or source.lot_id = ${lotId}::uuid)
                                   and (${serialId}::uuid is null or source.serial_id = ${serialId}::uuid)
                              ))),0)
            - coalesce((select sum(remaining_quantity) from inventory_provisional_costs
                         where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                           ${provisionalScope}
                           and ${sourceReceiptMovementId}::uuid is null
                           and ${lotId}::uuid is null and ${serialId}::uuid is null),0))::text as quantity,
           (coalesce((select sum(round(remaining_quantity * unit_cost,4)) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                         ${layerScope}
                         and (${sourceReceiptMovementId}::uuid is null or source_movement_id = ${sourceReceiptMovementId}::uuid)
                         and (${lotId}::uuid is null and ${serialId}::uuid is null
                              or exists (
                                select 1 from inventory_movements source
                                 where source.id = cost_layers.source_movement_id
                                   and source.org_id = ${orgId}
                                   and (${lotId}::uuid is null or source.lot_id = ${lotId}::uuid)
                                   and (${serialId}::uuid is null or source.serial_id = ${serialId}::uuid)
                              ))),0)
            - coalesce((select sum(round(remaining_quantity * provisional_unit_cost,4)) from inventory_provisional_costs
                         where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                           ${provisionalScope}
                           and ${sourceReceiptMovementId}::uuid is null
                           and ${lotId}::uuid is null and ${serialId}::uuid is null),0))::text as value`));
  const quantity = r.rows[0]?.quantity ?? "0";
  const value = r.rows[0]?.value ?? "0";
  const unitCost = isZero(quantity)
    ? "0"
    : unitCostPerQuantity(value, quantity)!;
  return {
    quantity: fromUnits(toUnits(quantity)),
    value: fromUnits(toUnits(value)),
    unitCost,
  };
}

export async function lockInventoryPosition(
  tx: Runner,
  itemId: string,
  stockLocationId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`inventory:${itemId}:${stockLocationId}`},0)),
      set_config('openbooks.inventory_original_cost_writer','basis-v1',true)`,
  );
}

export function assertInventoryDate(value: string, label: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new InventoryError(`${label} must be a valid YYYY-MM-DD date`);
  }
}
