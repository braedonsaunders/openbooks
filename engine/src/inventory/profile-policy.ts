import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { restrictionAdmits, type SubsidiaryContext } from "../organization/subsidiaries.ts";
import { type InventoryProfile, InventoryError, InventoryOwnershipError, CostingPolicyChangeBlockedError, type Runner } from "./contracts.ts";
import { assertWarehouseAdmitsMovement, type StockMovementDirection } from "./warehouses.ts";
import { assertSubcontractCustodyFeature } from "./subcontract-custody.ts";
/**
 * A stock location sits under a `locations` dimension row that may be
 * restricted to one subsidiary's subtree. Receiving into, issuing from, or
 * transferring through a location that does not admit the posting entity is
 * exactly how one subsidiary ends up holding another's goods.
 *
 * The same check enforces the enclosing warehouse's lifecycle for the
 * movement's direction (see `warehouseAdmits`). Every caller names its
 * direction; there is no default, because guessing it is how a suspended
 * warehouse would quietly take stock.
 */
export async function assertStockLocationAdmitsSubsidiary(
  tx: Runner,
  orgId: string,
  ctx: SubsidiaryContext,
  stockLocationId: string,
  subsidiaryId: string,
  direction: StockMovementDirection,
): Promise<void> {
  // Hold the warehouse row through the caller's transaction. A concurrent
  // deactivation waits for in-flight movements, while a movement that arrives
  // after deactivation re-reads the committed inactive row and refuses it.
  // Share locks remain compatible across concurrent movements.
  const r = (await tx.execute<{
      code: string;
      isActive: boolean;
      subsidiary_id: string | null;
      includeChildren: boolean;
      kind: string;
    }>(sql`
    select sl.code, sl.kind, sl.is_active as "isActive", l.subsidiary_id,
           l.subsidiary_include_children as "includeChildren"
      from stock_locations sl
      join locations l on l.id = sl.location_id and l.org_id = sl.org_id
     where sl.id = ${stockLocationId} and sl.org_id = ${orgId}
     for share of sl`));
  const location = r.rows[0];
  if (!location) {
    throw new InventoryError(
      `stock location ${stockLocationId} does not belong to the organization`,
    );
  }
  if (!location.isActive) {
    throw new InventoryError(`stock location "${location.code}" is inactive`);
  }
  if (location.kind==='subcontract') await assertSubcontractCustodyFeature(tx as SqlExecutor,orgId);
  if (
    !restrictionAdmits(ctx, location.subsidiary_id, location.includeChildren, subsidiaryId)
  ) {
    throw new InventoryOwnershipError(
      `stock location "${location.code}" is restricted to another legal entity`,
    );
  }
  await assertWarehouseAdmitsMovement(tx, orgId, stockLocationId, direction);
}

/**
 * Fail closed when a position holds open layers owned by ANOTHER entity.
 * Consuming them is storage-impossible since ownership landed in the schema,
 * but a bare "insufficient stock" would leak another entity's holdings and
 * mask the real authorization problem — name it instead.
 */
export async function assertNoForeignOnHand(
  tx: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  subsidiaryId: string,
): Promise<void> {
  const r = (await tx.execute(sql`
    select 1 from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}
       and stock_location_id = ${stockLocationId}
       and remaining_quantity > 0
       and subsidiary_id <> ${subsidiaryId}
     limit 1`));
  if (r.rows.length) {
    throw new InventoryOwnershipError(
      "on-hand stock at this location is owned by another legal entity",
    );
  }
}

export async function resolveProfile(
  orgId: string,
  itemId: string,
  runner: Runner = db,
  lock = false,
): Promise<InventoryProfile> {
  const r = (await runner.execute<{
      item_id: string;
      costing_method: InventoryProfile["costingMethod"];
      tracking: InventoryProfile["tracking"];
      asset_account_id: string;
      cogs_account_id: string;
      adjustment_account_id: string | null;
      variance_account_id: string | null;
      standard_cost: string | null;
      base_unit: string;
      unit_conversions: unknown;
      allow_negative_inventory: boolean;
      negative_cost_basis: InventoryProfile["negativeCostBasis"];
      provisional_unit_cost: string | null;
    }>(sql`
    select item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
           variance_account_id, standard_cost, base_unit, unit_conversions, allow_negative_inventory,
           negative_cost_basis, provisional_unit_cost
      from item_inventory_profiles where org_id = ${orgId} and item_id = ${itemId}
     ${lock ? sql`for share` : sql``}`));
  const p = r.rows[0];
  if (!p) throw new InventoryError(`item ${itemId} has no inventory profile`);
  if (p.tracking !== "none" && p.costing_method === "moving_average") {
    throw new InventoryError(
      "lot/serial tracking is incompatible with blended moving-average layers",
    );
  }
  const conversions = parseUnitConversions(p.unit_conversions);
  if (conversions === "invalid") throw new InventoryError("Item unit conversions are invalid — correct the inventory profile");
  return {
    itemId: p.item_id,
    costingMethod: p.costing_method,
    tracking: p.tracking,
    assetAccountId: p.asset_account_id,
    cogsAccountId: p.cogs_account_id,
    adjustmentAccountId: p.adjustment_account_id,
    varianceAccountId: p.variance_account_id,
    standardCost: p.standard_cost,
    baseUnit: p.base_unit,
    unitConversions: conversions ?? {},
    allowNegativeInventory: p.allow_negative_inventory,
    negativeCostBasis: p.negative_cost_basis,
    provisionalUnitCost: p.provisional_unit_cost,
  };
}

// ---------------------------------------------------------------------------
// Item costing profile policy changes
// ---------------------------------------------------------------------------

export type CostingMethod = InventoryProfile["costingMethod"];
export type TrackingMode = InventoryProfile["tracking"];

export type ItemInventoryProfileRow = {
  id: string;
  abc_class: string | null;
  item_id: string;
  costing_method: CostingMethod;
  tracking: TrackingMode;
  asset_account_id: string;
  cogs_account_id: string;
  adjustment_account_id: string | null;
  variance_account_id: string | null;
  received_not_billed_account_id: string | null;
  standard_cost: string | null;
  base_unit: string;
  unit_conversions: unknown;
  reorder_point: string | null;
  preferred_stock_level: string | null;
  allow_negative_inventory: boolean;
  negative_cost_basis: InventoryProfile["negativeCostBasis"];
  provisional_unit_cost: string | null;
};

const RE_COSTING_AUTHORIZATION_MIN_LENGTH = 5;
const RE_COSTING_AUTHORIZATION_MAX_LENGTH = 500;

export function parseCostingMethod(value: unknown): CostingMethod | null {
  return value === "fifo" || value === "moving_average" || value === "standard"
    ? value
    : null;
}

export function parseTrackingMode(value: unknown): TrackingMode | null {
  return value === "none" || value === "lot" || value === "serial" || value === "lot_serial"
    ? value
    : null;
}

/**
 * Parse the item's unit-conversion map (base units per unit, e.g.
 * { box: 12 }) from an API body. `undefined` means omitted (leave the stored
 * map alone); explicit `null` clears it. Anything else must be a JSON object
 * of non-blank unit names to positive, exactly-representable factors —
 * anything looser would reach toBaseQuantity as a guess at posting time.
 * Returns the normalized record, or the string "invalid" when the shape is
 * wrong (callers map that to their 422).
 */
export function parseUnitConversions(
  value: unknown,
): Record<string, number> | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const out: Record<string, number> = {};
  const seenFolded = new Set<string>();
  for (const [rawKey, rawFactor] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) return "invalid";
    // Posting folds case, so "box" beside "BOX" is an ambiguous map, not two
    // units — refuse it at the boundary rather than resolving it by key order.
    const folded = key.toLowerCase();
    if (seenFolded.has(folded)) return "invalid";
    seenFolded.add(folded);
    if (
      typeof rawFactor !== "number" ||
      !Number.isFinite(rawFactor) ||
      rawFactor <= 0
    ) {
      return "invalid";
    }
    // Factors multiply exact 4dp quantities; an inexact factor (1/3 as a
    // float) could never convert without inventing precision.
    if (!/^\d+(\.\d{1,4})?$/.test(String(rawFactor))) return "invalid";
    out[key] = rawFactor;
  }
  return out;
}

export async function lockItemInventoryProfile(
  tx: Runner,
  orgId: string,
  itemId: string,
): Promise<ItemInventoryProfileRow | null> {
  const r = (await tx.execute<ItemInventoryProfileRow>(sql`
    select id, abc_class, item_id, costing_method, tracking, asset_account_id, cogs_account_id,
           adjustment_account_id, variance_account_id, received_not_billed_account_id,
           standard_cost, base_unit, unit_conversions, reorder_point, preferred_stock_level,
           allow_negative_inventory, negative_cost_basis, provisional_unit_cost
      from item_inventory_profiles
     where org_id = ${orgId} and item_id = ${itemId}
     for update`));
  return r.rows[0] ?? null;
}

export interface CostingPolicyAssessment {
  changed: boolean;
  historyExisted: boolean;
}

/**
 * A costing method or tracking mode is accounting policy (ASC 250 / IAS 8):
 * once an item carries cost layers or posted movements, changing either needs
 * an explicit reasoned re-costing authorization from the caller. Refuses the
 * silent-policy hazard of defaulting, and refuses combinations the costing
 * engine cannot consume.
 */
export async function assertCostingPolicyChangeAllowed(
  tx: Runner,
  orgId: string,
  itemId: string,
  current: ItemInventoryProfileRow | null,
  next: { costingMethod: CostingMethod; tracking: TrackingMode },
  recostingAuthorization: string | null,
): Promise<CostingPolicyAssessment> {
  if (next.tracking !== "none" && next.costingMethod === "moving_average") {
    throw new InventoryError(
      "lot/serial tracking is incompatible with blended moving-average layers",
    );
  }
  const changed =
    !current ||
    current.costing_method !== next.costingMethod ||
    current.tracking !== next.tracking;
  if (!changed) return { changed: false, historyExisted: false };
  if (current && current.tracking !== next.tracking) {
    const custody = (await tx.execute(sql`select 1 from consignment_stock where org_id=${orgId} and item_id=${itemId} and remaining_quantity>0 limit 1`)).rows;
    if (custody.length) throw new CostingPolicyChangeBlockedError('Return or take ownership of consigned stock before changing its tracking mode');
  }
  const history = (await tx.execute<{ has_history: boolean }>(sql`
    select exists(select 1 from cost_layers where org_id = ${orgId} and item_id = ${itemId})
        or exists(select 1 from inventory_movements where org_id = ${orgId} and item_id = ${itemId})
        or exists(select 1 from consignment_stock where org_id = ${orgId} and item_id = ${itemId})
      as has_history`));
  if (history.rows[0]?.has_history !== true) {
    return { changed: true, historyExisted: false };
  }
  const reason = recostingAuthorization?.trim() ?? "";
  if (
    reason.length < RE_COSTING_AUTHORIZATION_MIN_LENGTH ||
    reason.length > RE_COSTING_AUTHORIZATION_MAX_LENGTH
  ) {
    throw new CostingPolicyChangeBlockedError(
      "changing the costing method or tracking of an item with inventory history requires an explicit re-costing authorization reason",
    );
  }
  return { changed: true, historyExisted: true };
}

/** Every movement books into exactly one active legal entity. */
export function assertMovementOwner(ctx: SubsidiaryContext, subsidiaryId: string): void {
  const owner = ctx.byId.get(subsidiaryId);
  if (!owner) throw new InventoryError(`subsidiary ${subsidiaryId} does not exist`);
  if (!owner.isActive) {
    throw new InventoryError(`subsidiary "${owner.name}" is inactive`);
  }
}

/** Registry default is on — absence must not disable inventory. Resolved
 * through the canonical switchboard: the previous inline ::boolean cast
 * threw 22P02 on a non-boolean stored value. */
export async function inventoryFeatureEnabled(
  runner: Runner,
  orgId: string,
): Promise<boolean> {
  return orgFeatureEnabled(orgId, "inventory", runner as SqlExecutor);
}

/**
 * With Inventory off a document's stock lines move no stock and book no COGS.
 * That is only sound for items that hold nothing: an item that still has
 * stock on hand, open cost layers or unsettled negative stock would sell
 * without relieving its cost, or receive without a layer. Turning Inventory
 * off is refused in that state, so this is the posting-side guard for stock
 * that predates the refusal.
 */
export async function assertInventoryOffHoldsNoStock(
  runner: Runner,
  orgId: string,
  itemIds: string[],
  activity: string,
): Promise<void> {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return;
  const held = (await runner.execute<{ label: string }>(sql`
    select coalesce(nullif(btrim(item.code), ''), item.name) as label
      from items item
     where item.org_id = ${orgId}
       and item.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       and (exists (select 1 from cost_layers layer where layer.org_id = item.org_id
                     and layer.item_id = item.id and layer.remaining_quantity > 0)
         or exists (select 1 from inventory_provisional_costs provisional where provisional.org_id = item.org_id
                     and provisional.item_id = item.id and provisional.remaining_quantity > 0))
     order by 1`)).rows;
  if (held.length === 0) return;
  const labels = held.map((row) => row.label).join(", ");
  throw new InventoryError(
    `Inventory is turned off, but ${labels} still ${held.length === 1 ? "has" : "have"} stock on hand or open cost layers, so this ${activity} would post without moving stock or its cost — turn Inventory back on under Company Settings → Features before posting`,
  );
}

/** New stock activity holds the authoritative feature through its write transaction. */
export async function assertInventoryFeature(runner: Runner, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, "inventory"))) {
    throw new InventoryError("inventory feature is disabled");
  }
}
