import { sql } from "drizzle-orm";
import type { PutawayStrategy } from "@openbooks/schema";
import { isZero, normalizeDecimal } from "../money/money.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { getOnHandWith, persistReceiptMoney } from "./position.ts";
import { transferInventoryTx } from "./transfers.ts";
import {
  WarehouseRefusal,
  assertWarehousingFeature,
  warehouseAdmits,
  warehousePositions,
  type WarehouseStatus,
} from "./warehouses.ts";

export type { PutawayStrategy };

const RULES_REMEDY = "Warehouse → Putaway rules";

/** Quantities compare at the rule capacity's scale (numeric(28,8)), in BigInt. */
function scaled(value: string): bigint {
  return BigInt(normalizeDecimal(value, 8).replace(".", ""));
}

/** A capacity as the operator entered it, without the storage scale's trailing zeros. */
function capacityLabel(value: string): string {
  return normalizeDecimal(value, 8).replace(/\.?0+$/, "");
}

function fitsCapacity(onHand: string, quantity: string, capacity: string | null): boolean {
  return capacity === null || scaled(onHand) + scaled(quantity) <= scaled(capacity);
}

export type PutawayRuleRecord = {
  id: string;
  warehouseId: string;
  sequence: number;
  itemId: string | null;
  strategy: PutawayStrategy;
  targetLocationId: string;
  targetCode: string;
  targetActive: boolean;
  capacityQuantity: string | null;
};

export async function listPutawayRules(runner: Runner, orgId: string, warehouseId: string): Promise<PutawayRuleRecord[]> {
  await assertWarehousingFeature(runner, orgId);
  const r = await runner.execute<PutawayRuleRecord>(sql`
    select r.id, r.warehouse_id as "warehouseId", r.sequence, r.item_id as "itemId", r.strategy,
           r.target_location_id as "targetLocationId", t.code as "targetCode", t.is_active as "targetActive",
           r.capacity_quantity::text as "capacityQuantity"
      from putaway_rules r
      join stock_locations t on t.id = r.target_location_id and t.org_id = r.org_id
     where r.org_id = ${orgId} and r.warehouse_id = ${warehouseId}
     order by r.sequence`);
  return r.rows;
}

export interface PutawayResolution {
  stockLocationId: string;
  code: string;
  ruleId: string;
  sequence: number;
}

export interface ResolvePutawayInput {
  itemId: string;
  quantity: string;
  warehouseId: string;
  subsidiaryId: string;
}

async function emptyBinUnder(
  runner: Runner,
  orgId: string,
  zoneId: string,
): Promise<{ id: string; code: string } | null> {
  const bins = (await runner.execute<{ id: string; code: string }>(sql`
    with recursive tree as (
      select id, kind, code, is_active, 0 as depth from stock_locations where org_id = ${orgId} and id = ${zoneId}
      union all
      select c.id, c.kind, c.code, c.is_active, t.depth + 1
        from stock_locations c join tree t on c.parent_id = t.id
       where c.org_id = ${orgId} and c.kind <> 'warehouse' and t.depth < 64
    )
    select id, code from tree where kind = 'bin' and is_active and depth > 0 order by code, id`)).rows;
  for (const bin of bins) {
    const items = (await runner.execute<{ item_id: string }>(sql`
      select item_id from cost_layers
       where org_id = ${orgId} and stock_location_id = ${bin.id} and remaining_quantity <> 0
      union
      select item_id from inventory_provisional_costs
       where org_id = ${orgId} and stock_location_id = ${bin.id} and remaining_quantity <> 0
      order by 1`)).rows;
    let empty = true;
    for (const { item_id } of items) {
      if (!isZero((await getOnHandWith(runner, orgId, item_id, bin.id)).quantity)) {
        empty = false;
        break;
      }
    }
    if (empty) return bin;
  }
  return null;
}

/**
 * Decide where received stock goes. Rules apply in sequence order, item
 * rules and every-item rules alike: a fixed bin while the item's on-hand
 * there plus the quantity stays within capacity (no capacity = always); the
 * first active bin under the target, by code, holding nothing at all; or a
 * bulk zone while the item's on-hand there plus the quantity fits. Capacity
 * is physical, so on-hand spans every legal entity at the location. The same
 * rules and stock always resolve to the same location; when nothing admits
 * the quantity the refusal names every rule tried and why it declined.
 */
export async function resolvePutawayLocation(
  runner: Runner,
  orgId: string,
  input: ResolvePutawayInput,
): Promise<PutawayResolution> {
  await assertWarehousingFeature(runner, orgId);
  const quantity = persistReceiptMoney(input.quantity, "putaway quantity");
  if (!(scaled(quantity) > 0n)) throw new InventoryError("putaway quantity must be positive");
  const warehouse = (await runner.execute<{ code: string; status: WarehouseStatus }>(sql`
    select sl.code, w.status from warehouses w
      join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
     where w.org_id = ${orgId} and w.stock_location_id = ${input.warehouseId}`)).rows[0];
  if (!warehouse) {
    throw new WarehouseRefusal(
      "warehouse not found in this organization",
      "warehouse_not_found",
      "choose a warehouse listed in Warehouse → Warehouses",
      422,
    );
  }
  if (!warehouseAdmits(warehouse.status, "inbound")) {
    throw new WarehouseRefusal(
      `warehouse ${warehouse.code} is ${warehouse.status} and takes no putaway`,
      "warehouse_not_admitting",
      `activate ${warehouse.code} in Warehouse → Warehouses`,
    );
  }
  const item = (await runner.execute<{ label: string }>(sql`
    select coalesce(nullif(code, ''), name) as label from items where org_id = ${orgId} and id = ${input.itemId}`)).rows[0];
  if (!item) throw new InventoryError("putaway references an item outside this organization");
  const rules = (await listPutawayRules(runner, orgId, input.warehouseId))
    .filter((rule) => rule.itemId === null || rule.itemId === input.itemId);
  const declined: string[] = [];
  for (const rule of rules) {
    const tried = `rule ${rule.sequence} (${rule.strategy} ${rule.targetCode})`;
    if (!rule.targetActive) {
      declined.push(`${tried}: ${rule.targetCode} is inactive`);
      continue;
    }
    if (rule.strategy === "empty-bin") {
      if (rule.capacityQuantity !== null && !fitsCapacity("0", quantity, rule.capacityQuantity)) {
        declined.push(`${tried}: ${quantity} exceeds the bin capacity ${capacityLabel(rule.capacityQuantity)}`);
        continue;
      }
      const bin = await emptyBinUnder(runner, orgId, rule.targetLocationId);
      if (!bin) {
        declined.push(`${tried}: no active bin under ${rule.targetCode} is empty`);
        continue;
      }
      return { stockLocationId: bin.id, code: bin.code, ruleId: rule.id, sequence: rule.sequence };
    }
    const onHand = (await getOnHandWith(runner, orgId, input.itemId, rule.targetLocationId)).quantity;
    if (!fitsCapacity(onHand, quantity, rule.capacityQuantity)) {
      declined.push(`${tried}: ${onHand} on hand plus ${quantity} exceeds capacity ${capacityLabel(rule.capacityQuantity!)}`);
      continue;
    }
    return { stockLocationId: rule.targetLocationId, code: rule.targetCode, ruleId: rule.id, sequence: rule.sequence };
  }
  const why = declined.length > 0 ? `; tried ${declined.join("; ")}` : "; no rule applies to this item";
  throw new WarehouseRefusal(
    `no putaway rule in ${warehouse.code} admits ${quantity} of ${item.label}${why}`,
    "putaway_unresolved",
    `add or widen a rule in ${RULES_REMEDY}`,
  );
}

export interface StagedStockRow {
  warehouseId: string;
  warehouseCode: string;
  stagingLocationId: string;
  stagingCode: string;
  itemId: string;
  itemLabel: string;
  subsidiaryId: string;
  quantity: string;
}

/**
 * Stock waiting in a warehouse's staging locations, one row per item and
 * owning entity, read through `getOnHandWith` so the queue shows exactly
 * what a putaway would move.
 */
export async function listStagedStock(
  runner: Runner,
  orgId: string,
  subsidiaryIds: readonly string[] | null,
): Promise<StagedStockRow[]> {
  await assertWarehousingFeature(runner, orgId);
  const warehouses = (await runner.execute<{ id: string; code: string }>(sql`
    select w.stock_location_id as id, sl.code from warehouses w
      join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
     where w.org_id = ${orgId} and w.status in ('active', 'suspended')
     order by sl.code`)).rows;
  const rows: StagedStockRow[] = [];
  for (const warehouse of warehouses) {
    const positions = (await warehousePositions(runner, orgId, warehouse.id, { kinds: ["staging"] }))
      .filter((p) => subsidiaryIds === null || subsidiaryIds.includes(p.subsidiaryId));
    if (positions.length === 0) continue;
    const meta = (await runner.execute<{ kind: "item" | "location"; id: string; label: string }>(sql`
      select 'item' as kind, id, coalesce(nullif(code, ''), name) as label from items
       where org_id = ${orgId} and id in (${sql.join(positions.map((p) => sql`${p.itemId}::uuid`), sql`, `)})
      union all
      select 'location', id, code from stock_locations
       where org_id = ${orgId} and id in (${sql.join(positions.map((p) => sql`${p.stockLocationId}::uuid`), sql`, `)})`)).rows;
    const label = (kind: "item" | "location", id: string) =>
      meta.find((row) => row.kind === kind && row.id === id)?.label ?? id;
    for (const position of positions) {
      const onHand = await getOnHandWith(runner, orgId, position.itemId, position.stockLocationId, {
        subsidiaryId: position.subsidiaryId,
      });
      if (!(scaled(onHand.quantity) > 0n)) continue;
      rows.push({
        warehouseId: warehouse.id,
        warehouseCode: warehouse.code,
        stagingLocationId: position.stockLocationId,
        stagingCode: label("location", position.stockLocationId),
        itemId: position.itemId,
        itemLabel: label("item", position.itemId),
        subsidiaryId: position.subsidiaryId,
        quantity: onHand.quantity,
      });
    }
  }
  return rows;
}

export interface PutAwayInput {
  warehouseId: string;
  stagingLocationId: string;
  itemId: string;
  subsidiaryId: string;
  quantity: string;
  date: string;
}

/**
 * Directed putaway: move staged stock to the location the rules resolve,
 * through the ordinary transfer path (same costing, admission and journal
 * behaviour as any transfer; no new movement type). The staging location
 * must be a staging location inside the named warehouse.
 */
export async function putAwayStagedStock(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  input: PutAwayInput,
): Promise<PutawayResolution & { fromMovementId: string; toMovementId: string; entryId: string | null }> {
  await assertWarehousingFeature(tx, orgId);
  const staging = (await tx.execute<{ code: string; kind: string; warehouse_id: string | null }>(sql`
    select code, kind, stock_location_warehouse(${orgId}::uuid, id) as warehouse_id
      from stock_locations where org_id = ${orgId} and id = ${input.stagingLocationId}`)).rows[0];
  if (!staging || staging.kind !== "staging" || staging.warehouse_id !== input.warehouseId) {
    throw new WarehouseRefusal(
      "putaway moves stock out of a staging location of the chosen warehouse",
      "not_a_staging_location",
      "choose a row from the stock awaiting putaway",
      422,
    );
  }
  const target = await resolvePutawayLocation(tx, orgId, {
    itemId: input.itemId,
    quantity: input.quantity,
    warehouseId: input.warehouseId,
    subsidiaryId: input.subsidiaryId,
  });
  const moved = await transferInventoryTx(tx, orgId, actorId, {
    itemId: input.itemId,
    fromStockLocationId: input.stagingLocationId,
    toStockLocationId: target.stockLocationId,
    quantity: input.quantity,
    subsidiaryId: input.subsidiaryId,
    date: input.date,
    memo: `Putaway ${staging.code} → ${target.code} (rule ${target.sequence})`,
  });
  return { ...target, fromMovementId: moved.fromMovementId, toMovementId: moved.toMovementId, entryId: moved.entryId };
}
