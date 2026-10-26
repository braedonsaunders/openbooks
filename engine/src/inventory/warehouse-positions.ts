import { sql } from "drizzle-orm";
import type { WarehouseStatus } from "@openbooks/schema";
import { add, isZero, neg, sum } from "../money/money.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { type Runner } from "./contracts.ts";
import { pickReservationsCte } from "./pick-reservations.ts";
import { getOnHandWith } from "./position.ts";
import { WarehouseRefusal, assertWarehousingFeature } from "./warehouse-admission.ts";
import { type WarehouseRecord } from "./warehouse-records.ts";
export type WarehousePosition = {
  itemId: string;
  stockLocationId: string;
  subsidiaryId: string;
};

/**
 * Every (item, location, owning entity) position inside a warehouse that
 * carries open layers or provisional (negative) stock, in canonical lock
 * order. Lock-free discovery: callers that need a stable answer fence these
 * positions and re-read quantities through `getOnHandWith`.
 */
export async function warehousePositions(
  runner: Runner,
  orgId: string,
  warehouseId: string,
  opts: { kinds?: readonly string[] } = {},
): Promise<WarehousePosition[]> {
  const kindFilter = opts.kinds?.length
    ? sql`and t.kind in (${sql.join(
        opts.kinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})`
    : sql``;
  const r = await runner.execute<WarehousePosition>(
    sql`
    with recursive tree as (
      select id, kind, 0 as depth from stock_locations where org_id = ${orgId} and id = ${warehouseId}
      union all
      select c.id, c.kind, t.depth + 1
        from stock_locations c join tree t on c.parent_id = t.id
       where c.org_id = ${orgId} and c.kind <> 'warehouse' and t.depth < 64
    ),
    scoped as (select t.id from tree t where true ${kindFilter})
    select distinct p.item_id as "itemId", p.stock_location_id as "stockLocationId", p.subsidiary_id as "subsidiaryId"
      from (
        select item_id, stock_location_id, subsidiary_id from cost_layers
         where org_id = ${orgId} and remaining_quantity <> 0 and stock_location_id in (select id from scoped)
        union
        select pc.item_id, pc.stock_location_id, mv.subsidiary_id
          from inventory_provisional_costs pc
          join inventory_movements mv on mv.id = pc.issue_movement_id and mv.org_id = pc.org_id
         where pc.org_id = ${orgId} and pc.remaining_quantity <> 0 and pc.stock_location_id in (select id from scoped)
      ) p
     order by 1, 2, 3`,
    "objects",
  );
  return r;
}

type StockLocationTreeRow = { id: string; parent_id: string | null; code: string; depth: number };
type PickLocationReservation = { pick_list_number: string; bin_code: string };
type StockLocationHistory = { code: string; blocker: string };

/** Refuse to remove a location while its tree has stock, reservations, or immutable operational history. */
export async function assertStockLocationDeletionAllowed(
  tx: Runner,
  orgId: string,
  stockLocationId: string,
): Promise<void> {
  const locations = await tx.execute<StockLocationTreeRow>(
    sql`
    with recursive subtree as (
      select id, parent_id, code, 0 as depth
        from stock_locations where org_id = ${orgId} and id = ${stockLocationId}
      union all
      select child.id, child.parent_id, child.code, parent.depth + 1
        from stock_locations child join subtree parent on child.parent_id = parent.id
       where child.org_id = ${orgId} and parent.depth < 64
    )
    select location.id, location.parent_id, location.code, subtree.depth
      from subtree join stock_locations location on location.id = subtree.id and location.org_id = ${orgId}
     order by location.id
     for update of location`,
    "objects",
  );
  if (locations.length === 0) {
    throw new WarehouseRefusal(
      "stock location was not found",
      "stock_location_not_found",
      "choose an existing stock location",
      422,
    );
  }

  const root = locations.find((location) => location.id === stockLocationId)!;
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const ids = uuidArray(locations.map((location) => location.id));

  const reservation = (
    await tx.execute<PickLocationReservation>(
      sql`
    with ${pickReservationsCte(orgId)}
    select reservations.pick_list_number, location.code as bin_code
      from pick_reservations reservations
      join stock_locations location on location.id = reservations.bin_id and location.org_id = ${orgId}
     where reservations.reserved > 0 and reservations.bin_id = any(${ids}::uuid[])
     order by reservations.pick_list_number, location.code
     limit 1`,
      "objects",
    )
  )[0];
  if (reservation) {
    const remedy = `ship or void pick list ${reservation.pick_list_number} first`;
    throw new WarehouseRefusal(
      `Stock location ${root.code} cannot be deleted because open pick list ${reservation.pick_list_number} reserves bin ${reservation.bin_code}.`,
      "stock_location_in_use",
      remedy,
    );
  }

  const positions = await warehousePositions(tx, orgId, stockLocationId);
  for (const position of positions) {
    const onHand = await getOnHandWith(tx, orgId, position.itemId, position.stockLocationId, {
      subsidiaryId: position.subsidiaryId,
    });
    if (isZero(onHand.quantity)) continue;
    const blockerLocation =
      locationById.get(position.stockLocationId)?.code ?? position.stockLocationId;
    const remedy = "transfer or issue the remaining stock first";
    throw new WarehouseRefusal(
      `Stock location ${root.code} cannot be deleted because ${onHand.quantity} remains on hand at ${blockerLocation}.`,
      "stock_location_in_use",
      remedy,
    );
  }

  const history = (
    await tx.execute<StockLocationHistory>(
      sql`
    select location.code, refs.blocker
      from (
        select stock_location_id as location_id, 'inventory movement history' as blocker from inventory_movements where org_id = ${orgId}
        union all
        select stock_location_id, 'inventory cost history' from cost_layers where org_id = ${orgId}
        union all
        select stock_location_id, 'provisional inventory history' from inventory_provisional_costs where org_id = ${orgId}
        union all
        select line.stock_location_id, 'document history' from document_lines line
         where line.org_id = ${orgId} and line.stock_location_id is not null
        union all
        select stock_location_id, 'stock-count history' from stock_count_lines where org_id = ${orgId}
        union all
        select current_stock_location_id, 'serial stock history' from serials
         where org_id = ${orgId} and current_stock_location_id is not null
      ) refs
      join stock_locations location on location.id = refs.location_id and location.org_id = ${orgId}
     where location.id = any(${ids}::uuid[])
     order by location.code, refs.blocker
     limit 1`,
      "objects",
    )
  )[0];
  if (history) {
    throw new WarehouseRefusal(
      `Stock location ${root.code} cannot be deleted because ${history.blocker} at ${history.code} preserves its audit history.`,
      "stock_location_in_use",
      "keep the location for audit history and clear Active instead",
    );
  }

  const child = locations.find((location) => location.depth > 0);
  if (child) {
    throw new WarehouseRefusal(
      `Stock location ${root.code} cannot be deleted because child location ${child.code} remains beneath it.`,
      "stock_location_in_use",
      "delete or reparent the child location first",
    );
  }
}

/** Retirement refuses while anything is on hand, naming each item and quantity. */
export async function assertWarehouseEmpty(
  tx: Runner,
  orgId: string,
  warehouse: WarehouseRecord,
): Promise<void> {
  const byItem = new Map<string, string>();
  for (const position of await warehousePositions(tx, orgId, warehouse.id)) {
    const onHand = await getOnHandWith(tx, orgId, position.itemId, position.stockLocationId, {
      subsidiaryId: position.subsidiaryId,
    });
    if (!isZero(onHand.quantity)) {
      byItem.set(position.itemId, add(byItem.get(position.itemId) ?? "0", onHand.quantity));
    }
  }
  const remaining = [...byItem].filter(([, quantity]) => !isZero(quantity));
  if (remaining.length === 0) return;
  const labels = await tx.execute<{ id: string; label: string }>(
    sql`
    select id, coalesce(nullif(code, ''), name) as label from items
     where org_id = ${orgId} and id in (${sql.join(
       remaining.map(([id]) => sql`${id}`),
       sql`, `,
     )})`,
    "objects",
  );
  const labelOf = new Map(labels.map((row) => [row.id, row.label]));
  const listed = remaining
    .map(([itemId, quantity]) => ({ label: labelOf.get(itemId) ?? itemId, quantity }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ label, quantity }) => `${quantity} of ${label}`);
  const remedy = "transfer or issue the remaining stock, then retire it";
  throw new WarehouseRefusal(
    `cannot retire ${warehouse.code}: it still holds ${listed.join(", ")}; ${remedy}`,
    "warehouse_not_empty",
    remedy,
  );
}

export interface WarehouseTieOutRow {
  /** Null for stock held in locations outside every warehouse. */
  warehouseId: string | null;
  code: string | null;
  name: string | null;
  status: WarehouseStatus | null;
  value: string;
}

export interface WarehouseTieOut {
  rows: WarehouseTieOutRow[];
  layerTotal: string;
  controlBalance: string;
  difference: string;
  controlAccountIds: string[];
}

/**
 * On-hand value by warehouse beside the inventory control accounts' posted
 * balance in the primary book, for the given legal entities (null = all).
 * Values come from `getOnHandWith` per position, so the tie-out reads the
 * same figures every movement costs against.
 */
export async function warehouseStockTieOut(
  runner: Runner,
  orgId: string,
  subsidiaryIds: readonly string[] | null,
): Promise<WarehouseTieOut> {
  await assertWarehousingFeature(runner, orgId);
  const subsidiaryFilter = (column: ReturnType<typeof sql.raw>) =>
    subsidiaryIds === null
      ? sql``
      : subsidiaryIds.length === 0
        ? sql`and false`
        : sql`and ${column} in (${sql.join(
            subsidiaryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  const positions = await runner.execute<WarehousePosition & { warehouseId: string | null }>(
    sql`
    select p.item_id as "itemId", p.stock_location_id as "stockLocationId", p.subsidiary_id as "subsidiaryId",
           stock_location_warehouse(${orgId}::uuid, p.stock_location_id) as "warehouseId"
      from (
        select item_id, stock_location_id, subsidiary_id from cost_layers
         where org_id = ${orgId} and remaining_quantity <> 0 ${subsidiaryFilter(sql.raw("subsidiary_id"))}
        union
        select pc.item_id, pc.stock_location_id, mv.subsidiary_id
          from inventory_provisional_costs pc
          join inventory_movements mv on mv.id = pc.issue_movement_id and mv.org_id = pc.org_id
         where pc.org_id = ${orgId} and pc.remaining_quantity <> 0 ${subsidiaryFilter(sql.raw("mv.subsidiary_id"))}
      ) p
     order by 1, 2, 3`,
    "objects",
  );
  const valueByWarehouse = new Map<string | null, string[]>();
  for (const position of positions) {
    const onHand = await getOnHandWith(runner, orgId, position.itemId, position.stockLocationId, {
      subsidiaryId: position.subsidiaryId,
    });
    const values = valueByWarehouse.get(position.warehouseId) ?? [];
    values.push(onHand.value);
    valueByWarehouse.set(position.warehouseId, values);
  }
  const warehouses = await runner.execute<{
    id: string;
    code: string;
    name: string;
    status: WarehouseStatus;
  }>(
    sql`
    select w.stock_location_id as id, sl.code, w.name, w.status
      from warehouses w join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
     where w.org_id = ${orgId}
     order by sl.code`,
    "objects",
  );
  const rows: WarehouseTieOutRow[] = warehouses.map((w) => ({
    warehouseId: w.id,
    code: w.code,
    name: w.name,
    status: w.status,
    value: sum(valueByWarehouse.get(w.id) ?? []),
  }));
  const unassigned = valueByWarehouse.get(null);
  if (unassigned)
    rows.push({ warehouseId: null, code: null, name: null, status: null, value: sum(unassigned) });
  const accounts = await runner.execute<{ id: string }>(
    sql`
    select distinct asset_account_id as id from item_inventory_profiles where org_id = ${orgId} order by 1`,
    "objects",
  );
  const controlAccountIds = accounts.map((a) => a.id);
  let controlBalance = "0";
  if (controlAccountIds.length > 0) {
    const balance = (
      await runner.execute<{ balance: string }>(
        sql`
      select coalesce(sum(l.amount), 0)::text as balance
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounting_books b on b.id = e.book_id and b.org_id = e.org_id and b.is_primary
       where l.org_id = ${orgId}
         and e.status in ('posted', 'reversed')
         and l.account_id in (${sql.join(
           controlAccountIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
         ${subsidiaryFilter(sql.raw("e.subsidiary_id"))}`,
        "objects",
      )
    )[0];
    controlBalance = sum([balance?.balance ?? "0"]);
  }
  const layerTotal = sum(rows.map((row) => row.value));
  return {
    rows,
    layerTotal,
    controlBalance,
    difference: sum([layerTotal, neg(controlBalance)]),
    controlAccountIds,
  };
}
