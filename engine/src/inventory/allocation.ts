import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, fromUnits, toUnits } from "../money/money.ts";
import { activePickReservations } from "./pick-reservations.ts";
import { saleableLocation, unheldTracking } from "./stock-eligibility.ts";
import { toBaseQuantity } from "./costing.ts";
import { InventoryError } from "./contracts.ts";

export interface PhysicalAllocation {
  binId: string;
  binCode: string;
  lotId: string | null;
  lotNumber: string | null;
  serialId: string | null;
  serialNumber: string | null;
  expiresOn: string | null;
  quantity: string;
}
/** FEFO chooses physical stock; consumeLayers retains its FIFO accounting order. */
export async function allocationCandidates(
  runner: SqlExecutor,
  orgId: string,
  itemId: string,
  warehouseId: string,
  subsidiaryId: string,
  unit: string | null,
): Promise<PhysicalAllocation[]> {
  const profile = (
    await runner.execute<{
      base_unit: string;
      unit_conversions: Record<string, number>;
    }>(sql`select base_unit,unit_conversions from item_inventory_profiles
    where org_id=${orgId} and item_id=${itemId}`)
  ).rows[0];
  if (!profile)
    throw new InventoryError("Allocation requires an inventory profile");
  const factor = toUnits(
    toBaseQuantity(
      "1",
      unit,
      profile.unit_conversions,
      profile.base_unit,
      "Pick allocation",
    ),
  );
  const rows = (
    await runner.execute<PhysicalAllocation>(sql`
    select sl.id as "binId",sl.code as "binCode",source.lot_id as "lotId",lot.lot_number as "lotNumber",
      source.serial_id as "serialId",serial.serial_number as "serialNumber",lot.expires_on::text as "expiresOn",sum(layer.remaining_quantity)::text as quantity
    from cost_layers layer join inventory_movements source on source.org_id=layer.org_id and source.id=layer.source_movement_id
      join stock_locations sl on sl.org_id=layer.org_id and sl.id=layer.stock_location_id
      left join lots lot on lot.org_id=source.org_id and lot.id=source.lot_id
      left join serials serial on serial.org_id=source.org_id and serial.id=source.serial_id
    where layer.org_id=${orgId} and layer.item_id=${itemId} and layer.subsidiary_id=${subsidiaryId} and layer.remaining_quantity>0
      and (source.serial_id is null or (serial.status='in_stock' and serial.current_stock_location_id=sl.id))
      and stock_location_warehouse(sl.org_id,sl.id)=${warehouseId}
      and ${saleableLocation(sql`sl.org_id`, sql`sl.id`)} and ${unheldTracking(sql`source.org_id`, sql`source.lot_id`, sql`source.serial_id`)}
    group by sl.id,sl.code,source.lot_id,lot.lot_number,source.serial_id,serial.serial_number,lot.expires_on
    order by lot.expires_on asc nulls last,min(layer.received_at),min(source.created_at),sl.code,source.lot_id nulls first,source.serial_id nulls first`)
  ).rows;
  const reserved = await activePickReservations(runner, orgId, {
    itemId,
    subsidiaryId,
  });
  return rows.flatMap((row) => {
    const held = reserved
      .filter(
        (h) =>
          h.binId === row.binId &&
          h.lotId === row.lotId &&
          h.serialId === row.serialId,
      )
      .reduce(
        (q, h) =>
          add(
            q,
            toBaseQuantity(
              h.reserved,
              h.unit ?? null,
              profile.unit_conversions,
              profile.base_unit,
              "Reserved pick",
            ),
          ),
        "0",
      );
    const base = toUnits(row.quantity) - toUnits(held);
    if (base <= 0n) return [];
    if ((base * 10000n) % factor !== 0n)
      throw new InventoryError(
        "Available stock cannot be represented in the order unit — use the inventory base unit",
      );
    return [{ ...row, quantity: fromUnits((base * 10000n) / factor) }];
  });
}
