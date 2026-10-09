import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { InventoryError } from "./contracts.ts";

interface SerialMovementInput {
  itemId: string;
  subsidiaryId: string;
  stockLocationId: string;
  serialId?: string | null;
  lotId?: string | null;
  stockCountLineId?: string;
  admission?: "count";
}

/** Associate a reviewed count before its serial transition; deferred storage proof requires the final posted audit. */
async function stampSerialCountMovement(
  tx: SqlExecutor, orgId: string, actorId: string | null,
  input: SerialMovementInput, movementId: string,
) {
  if (!input.stockCountLineId) return;
  if (input.admission !== "count" || !actorId)
    throw new InventoryError("Serial count adjustments require a named poster and the reviewed count line");
  await lockActorCommandAuthority(tx, orgId, actorId, input.subsidiaryId, "items.post");
  const locked = await tx.execute(sql`
    select line.id from stock_count_lines line join stock_counts count
      on count.org_id=line.org_id and count.id=line.stock_count_id
    where line.org_id=${orgId} and line.id=${input.stockCountLineId} and count.status='review'
      and line.item_id=${input.itemId} and line.stock_location_id=${input.stockLocationId}
      and line.serial_id=${input.serialId} and line.lot_id is not distinct from ${input.lotId ?? null}::uuid
      and count.subsidiary_id=${input.subsidiaryId} and line.adjustment_movement_id is null
    for update of count,line`);
  if (locked.rows.length !== 1)
    throw new InventoryError("Serial adjustment must match an unposted reviewed count line in this entity and location");
  const stamped = await tx.execute(sql`
    update stock_count_lines set adjustment_movement_id=${movementId},updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${input.stockCountLineId} and adjustment_movement_id is null returning id`);
  if (stamped.rows.length !== 1)
    throw new InventoryError("The serial count line was already posted; reload the count");
  const proof = (await tx.execute<{ valid: boolean }>(sql`
    select public.inventory_serial_count_line_matches(${orgId}::uuid,${input.stockCountLineId}::uuid,
      ${movementId}::uuid,false) as valid`)).rows[0];
  if (!proof?.valid)
    throw new InventoryError("Serial count adjustment requires its exact observation, variance and posted journal evidence");
}

export async function applySerialReceipt(
  tx: SqlExecutor, orgId: string, actorId: string | null,
  input: SerialMovementInput, movementId: string,
) {
  await stampSerialCountMovement(tx, orgId, actorId, input, movementId);
  if (input.stockCountLineId) {
    const proof = (await tx.execute<{ status: string; valid: boolean }>(sql`
      select serial.status,public.inventory_serial_count_restoration_matches(serial.org_id,serial.id,
        serial.current_missing_count_movement_id,${input.stockLocationId}::uuid,${movementId}::uuid) as valid
      from serials serial where serial.org_id=${orgId} and serial.id=${input.serialId} for update`)).rows[0];
    if (!proof || (proof.status === "shipped" && !proof.valid))
      throw new InventoryError("Found serial must recover its current posted missing-count issue in the same entity, lot and location; use the source shipment return for shipped stock");
  }
  const updated = await tx.execute(sql`
    update serials set status='in_stock',current_stock_location_id=${input.stockLocationId},
      updated_at=now(),updated_by=${actorId}
    where id=${input.serialId} and org_id=${orgId} returning id`);
  if (updated.rows.length !== 1) throw new InventoryError("Serial lifecycle update was not recorded");
}

export async function applySerialIssue(
  tx: SqlExecutor, orgId: string, actorId: string | null,
  input: SerialMovementInput, movementId: string,
) {
  await stampSerialCountMovement(tx, orgId, actorId, input, movementId);
  const updated = await tx.execute(sql`
    update serials set status='shipped',current_stock_location_id=null,
      current_missing_count_movement_id=${input.stockCountLineId ? movementId : null},updated_at=now(),updated_by=${actorId}
    where id=${input.serialId} and org_id=${orgId} returning id`);
  if (updated.rows.length !== 1) throw new InventoryError("Serial lifecycle update was not recorded");
}
