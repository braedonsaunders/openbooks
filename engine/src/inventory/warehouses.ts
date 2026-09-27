import { sql } from "drizzle-orm";
import type { WarehouseStatus } from "@openbooks/schema";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, isZero, neg, sum } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { getOnHandWith, lockInventoryPosition } from "./position.ts";

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

const FEATURES_REMEDY = "turn on Warehousing in Company Settings → Features";
const WAREHOUSES_REMEDY = "Warehouse → Warehouses";

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
export function warehouseAdmits(status: WarehouseStatus, direction: StockMovementDirection): boolean {
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
  const warehouse = (await tx.execute<{ code: string; status: WarehouseStatus }>(sql`
    select wl.code, w.status
      from warehouses w
      join stock_locations wl on wl.id = w.stock_location_id and wl.org_id = w.org_id
     where w.org_id = ${orgId}
       and w.stock_location_id = stock_location_warehouse(${orgId}::uuid, ${stockLocationId}::uuid)
     for share of w`)).rows[0];
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
 * Every warehouse function asserts the feature first. Creation holds the
 * feature switchboard row so a concurrent disable serializes against it;
 * lifecycle transitions read it without a lock because they only ever lock
 * the warehouse row, and a movement already holding that row FOR SHARE may
 * go on to lock the organization row at posting.
 */
export async function assertWarehousingFeature(
  runner: Runner,
  orgId: string,
  opts: { lock: boolean } = { lock: false },
): Promise<void> {
  const enabled = opts.lock
    ? await lockAndCheckOrgFeature(runner as SqlExecutor, orgId, "warehousing")
    : await orgFeatureEnabled(orgId, "warehousing", runner as SqlExecutor);
  if (!enabled) {
    throw new WarehouseRefusal(
      `warehousing is turned off for this organization; ${FEATURES_REMEDY}`,
      "warehousing_disabled",
      FEATURES_REMEDY,
    );
  }
}

export interface WarehouseAddress {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export type WarehouseRecord = Required<WarehouseAddress> & {
  id: string;
  code: string;
  name: string;
  status: WarehouseStatus;
  locationId: string;
  isActive: boolean;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
};

const WAREHOUSE_SELECT = sql`
  select w.stock_location_id as id, sl.code, w.name, w.status, sl.location_id as "locationId",
         sl.is_active as "isActive",
         w.address_line1 as "addressLine1", w.address_line2 as "addressLine2", w.city,
         w.region, w.postal_code as "postalCode", w.country,
         w.status_changed_at::text as "statusChangedAt", w.status_changed_by as "statusChangedBy"
    from warehouses w
    join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id`;

function cleanText(value: string | null | undefined, field: string, max = 200): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new WarehouseRefusal(`${field} must be at most ${max} characters`, "invalid_input", `shorten the ${field}`, 422);
  }
  return trimmed;
}

function cleanAddress(input: WarehouseAddress): Required<WarehouseAddress> {
  const country = cleanText(input.country, "country", 2)?.toUpperCase() ?? null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    throw new WarehouseRefusal(
      `country ${country} is not an ISO 3166-1 alpha-2 code`,
      "invalid_country",
      "enter the two-letter country code, for example US or DE",
      422,
    );
  }
  return {
    addressLine1: cleanText(input.addressLine1, "address line 1"),
    addressLine2: cleanText(input.addressLine2, "address line 2"),
    city: cleanText(input.city, "city"),
    region: cleanText(input.region, "region"),
    postalCode: cleanText(input.postalCode, "postal code", 40),
    country,
  };
}

async function writeWarehouseAudit(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  warehouseId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = (await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'warehouses', ${warehouseId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`));
  if (written.rows.length === 0) {
    throw new InventoryError("warehouse change was not audited; reload and try again");
  }
}

export async function listWarehouses(runner: Runner, orgId: string): Promise<WarehouseRecord[]> {
  await assertWarehousingFeature(runner, orgId);
  const r = await runner.execute<WarehouseRecord>(sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId}
     order by sl.code`);
  return r.rows;
}

export async function getWarehouse(runner: Runner, orgId: string, warehouseId: string): Promise<WarehouseRecord | null> {
  await assertWarehousingFeature(runner, orgId);
  const r = await runner.execute<WarehouseRecord>(sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId} and w.stock_location_id = ${warehouseId}`);
  return r.rows[0] ?? null;
}

/** The warehouse enclosing a stock location (itself included), or null. */
export async function warehouseOf(runner: Runner, orgId: string, stockLocationId: string): Promise<WarehouseRecord | null> {
  await assertWarehousingFeature(runner, orgId);
  const r = await runner.execute<WarehouseRecord>(sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId}
       and w.stock_location_id = stock_location_warehouse(${orgId}::uuid, ${stockLocationId}::uuid)`);
  return r.rows[0] ?? null;
}

export type WarehouseLocationRecord = {
  id: string;
  parentId: string | null;
  code: string;
  kind: string;
  isActive: boolean;
};

/** The zones, bins and staging areas beneath a warehouse, parents before children. */
export async function listWarehouseLocations(
  runner: Runner,
  orgId: string,
  warehouseId: string,
): Promise<WarehouseLocationRecord[]> {
  await assertWarehousingFeature(runner, orgId);
  const r = await runner.execute<WarehouseLocationRecord>(sql`
    with recursive tree as (
      select id, parent_id, code, kind, is_active, 0 as depth, code::text as path
        from stock_locations where org_id = ${orgId} and id = ${warehouseId} and kind = 'warehouse'
      union all
      select c.id, c.parent_id, c.code, c.kind, c.is_active, t.depth + 1, t.path || '/' || c.code
        from stock_locations c join tree t on c.parent_id = t.id
       where c.org_id = ${orgId} and c.kind <> 'warehouse' and t.depth < 64
    )
    select id, parent_id as "parentId", code, kind, is_active as "isActive"
      from tree where depth > 0 order by path`);
  return r.rows;
}

export interface CreateWarehouseInput extends WarehouseAddress {
  code: string;
  name: string;
  /** The `locations` dimension value the warehouse sits under. */
  locationId: string;
}

/**
 * Create a warehouse in draft. The warehouse-kind stock location is inserted
 * first; its insert trigger gives it the warehouse row every creation path
 * gets, and the same transaction then moves that row to draft with the name
 * and address, so no committed state ever shows an unnamed active warehouse.
 */
export async function createWarehouse(
  orgId: string,
  actorId: string | null,
  input: CreateWarehouseInput,
): Promise<WarehouseRecord> {
  const code = cleanText(input.code, "code", 40);
  const name = cleanText(input.name, "name");
  if (!code) throw new WarehouseRefusal("a warehouse needs a code", "code_required", "enter a code such as WH-01", 422);
  if (!name) throw new WarehouseRefusal("a warehouse needs a name", "name_required", "enter the warehouse name", 422);
  const address = cleanAddress(input);
  return db.transaction(async (tx) => {
    await assertWarehousingFeature(tx, orgId, { lock: true });
    const location = (await tx.execute<{ is_active: boolean }>(sql`
      select is_active from locations where org_id = ${orgId} and id = ${input.locationId}`)).rows[0];
    if (!location?.is_active) {
      throw new WarehouseRefusal(
        "the warehouse's location must be an active location of this organization",
        "location_required",
        "choose an active location, or activate one in Setup → Locations",
        422,
      );
    }
    const taken = (await tx.execute(sql`
      select 1 from stock_locations where org_id = ${orgId} and kind = 'warehouse' and code = ${code}`)).rows.length > 0;
    if (taken) {
      throw new WarehouseRefusal(
        `warehouse code ${code} is already in use`,
        "warehouse_code_taken",
        "choose a different warehouse code",
        409,
      );
    }
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into stock_locations (org_id, location_id, code, kind, is_active, created_by, updated_by)
      values (${orgId}, ${input.locationId}, ${code}, 'warehouse', true, ${actorId}, ${actorId})
      returning id`)).rows[0];
    if (!inserted) throw new InventoryError("warehouse stock location was not created");
    const updated = await tx.execute(sql`
      update warehouses
         set status = 'draft', name = ${name},
             address_line1 = ${address.addressLine1}, address_line2 = ${address.addressLine2},
             city = ${address.city}, region = ${address.region},
             postal_code = ${address.postalCode}, country = ${address.country},
             status_changed_at = now(), status_changed_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and stock_location_id = ${inserted.id}`);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new InventoryError(`warehouse ${code} has no warehouse row to name; the stock-location trigger did not run`);
    }
    const record = (await tx.execute<WarehouseRecord>(sql`
      ${WAREHOUSE_SELECT}
       where w.org_id = ${orgId} and w.stock_location_id = ${inserted.id}`)).rows[0]!;
    await writeWarehouseAudit(tx, orgId, actorId, record.id, "insert", { event: "warehouse_created", after: record });
    return record;
  });
}

/** Edit a warehouse's name and address. Status moves only through the lifecycle functions. */
export async function updateWarehouseDetails(
  orgId: string,
  actorId: string | null,
  warehouseId: string,
  patch: WarehouseAddress & { name?: string },
): Promise<WarehouseRecord> {
  return db.transaction(async (tx) => {
    await assertWarehousingFeature(tx, orgId);
    const before = await lockWarehouse(tx, orgId, warehouseId);
    const name = patch.name === undefined ? before.name : cleanText(patch.name, "name");
    if (!name) throw new WarehouseRefusal("a warehouse needs a name", "name_required", "enter the warehouse name", 422);
    const address = cleanAddress({
      addressLine1: patch.addressLine1 === undefined ? before.addressLine1 : patch.addressLine1,
      addressLine2: patch.addressLine2 === undefined ? before.addressLine2 : patch.addressLine2,
      city: patch.city === undefined ? before.city : patch.city,
      region: patch.region === undefined ? before.region : patch.region,
      postalCode: patch.postalCode === undefined ? before.postalCode : patch.postalCode,
      country: patch.country === undefined ? before.country : patch.country,
    });
    const updated = await tx.execute(sql`
      update warehouses
         set name = ${name},
             address_line1 = ${address.addressLine1}, address_line2 = ${address.addressLine2},
             city = ${address.city}, region = ${address.region},
             postal_code = ${address.postalCode}, country = ${address.country},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and stock_location_id = ${warehouseId}`);
    if ((updated.rowCount ?? 0) !== 1) throw new InventoryError(`warehouse ${before.code} was not updated`);
    const after = (await tx.execute<WarehouseRecord>(sql`
      ${WAREHOUSE_SELECT}
       where w.org_id = ${orgId} and w.stock_location_id = ${warehouseId}`)).rows[0]!;
    await writeWarehouseAudit(tx, orgId, actorId, warehouseId, "update", { event: "warehouse_details", before, after });
    return after;
  });
}

async function lockWarehouse(tx: Runner, orgId: string, warehouseId: string): Promise<WarehouseRecord> {
  const row = (await tx.execute<WarehouseRecord>(sql`
    ${WAREHOUSE_SELECT}
     where w.org_id = ${orgId} and w.stock_location_id = ${warehouseId}
     for update of w`)).rows[0];
  if (!row) {
    throw new WarehouseRefusal(
      "warehouse not found in this organization",
      "warehouse_not_found",
      `choose a warehouse listed in ${WAREHOUSES_REMEDY}`,
      422,
    );
  }
  return row;
}

type Transition = "activate" | "suspend" | "retire";

const TRANSITION_TARGET: Record<Transition, WarehouseStatus> = {
  activate: "active",
  suspend: "suspended",
  retire: "retired",
};

const TRANSITION_FROM: Record<Transition, readonly WarehouseStatus[]> = {
  activate: ["draft", "suspended"],
  suspend: ["active"],
  retire: ["active", "suspended"],
};

function transitionRefusal(verb: Transition, warehouse: WarehouseRecord): WarehouseRefusal {
  const target = TRANSITION_TARGET[verb];
  let remedy: string;
  if (warehouse.status === target) remedy = `it is already ${target}; no change is needed`;
  else if (warehouse.status === "retired") remedy = "a retired warehouse keeps its history and never reopens; create a new warehouse instead";
  else remedy = "activate it first";
  return new WarehouseRefusal(
    `cannot ${verb} ${warehouse.code} from ${warehouse.status}; ${remedy}`,
    "warehouse_transition_refused",
    remedy,
  );
}

function transitionReason(verb: Transition, reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? "";
  if (verb !== "activate" && trimmed.length < 3) {
    throw new WarehouseRefusal(
      `a reason is required to ${verb} a warehouse`,
      "reason_required",
      "enter why the warehouse is changing status",
      422,
    );
  }
  if (trimmed.length > 500) {
    throw new WarehouseRefusal("the reason must be at most 500 characters", "invalid_input", "shorten the reason", 422);
  }
  return trimmed === "" ? null : trimmed;
}

export interface WarehouseTransitionInput {
  warehouseId: string;
  reason?: string | null;
}

async function transitionWarehouse(
  verb: Transition,
  orgId: string,
  actorId: string | null,
  input: WarehouseTransitionInput,
): Promise<WarehouseRecord> {
  const reason = transitionReason(verb, input.reason);
  return db.transaction(async (tx) => {
    await assertWarehousingFeature(tx, orgId);
    if (verb === "retire") {
      // Canonical lock order: fence every position the warehouse holds before
      // any row lock. Positions are discovered lock-free, then re-read below.
      for (const position of await warehousePositions(tx, orgId, input.warehouseId)) {
        await lockInventoryPosition(tx, position.itemId, position.stockLocationId);
      }
    }
    const before = await lockWarehouse(tx, orgId, input.warehouseId);
    if (!TRANSITION_FROM[verb].includes(before.status)) throw transitionRefusal(verb, before);
    if (verb === "retire") await assertWarehouseEmpty(tx, orgId, before);
    const target = TRANSITION_TARGET[verb];
    const updated = await tx.execute(sql`
      update warehouses
         set status = ${target}, status_changed_at = now(), status_changed_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and stock_location_id = ${input.warehouseId} and status = ${before.status}`);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new InventoryError(`warehouse ${before.code} changed while it was being updated; reload and try again`);
    }
    const after = (await tx.execute<WarehouseRecord>(sql`
      ${WAREHOUSE_SELECT}
       where w.org_id = ${orgId} and w.stock_location_id = ${input.warehouseId}`)).rows[0]!;
    await writeWarehouseAudit(tx, orgId, actorId, input.warehouseId, "update", {
      event: "warehouse_status",
      reason,
      before: { status: before.status },
      after: { status: after.status },
    });
    return after;
  });
}

export const activateWarehouse = (orgId: string, actorId: string | null, input: WarehouseTransitionInput) =>
  transitionWarehouse("activate", orgId, actorId, input);
export const suspendWarehouse = (orgId: string, actorId: string | null, input: WarehouseTransitionInput) =>
  transitionWarehouse("suspend", orgId, actorId, input);
export const retireWarehouse = (orgId: string, actorId: string | null, input: WarehouseTransitionInput) =>
  transitionWarehouse("retire", orgId, actorId, input);

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
    ? sql`and t.kind in (${sql.join(opts.kinds.map((kind) => sql`${kind}`), sql`, `)})`
    : sql``;
  const r = await runner.execute<WarehousePosition>(sql`
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
     order by 1, 2, 3`);
  return r.rows;
}

/** Retirement refuses while anything is on hand, naming each item and quantity. */
async function assertWarehouseEmpty(tx: Runner, orgId: string, warehouse: WarehouseRecord): Promise<void> {
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
  const labels = (await tx.execute<{ id: string; label: string }>(sql`
    select id, coalesce(nullif(code, ''), name) as label from items
     where org_id = ${orgId} and id in (${sql.join(remaining.map(([id]) => sql`${id}`), sql`, `)})`)).rows;
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
        : sql`and ${column} in (${sql.join(subsidiaryIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  const positions = (await runner.execute<WarehousePosition & { warehouseId: string | null }>(sql`
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
     order by 1, 2, 3`)).rows;
  const valueByWarehouse = new Map<string | null, string[]>();
  for (const position of positions) {
    const onHand = await getOnHandWith(runner, orgId, position.itemId, position.stockLocationId, {
      subsidiaryId: position.subsidiaryId,
    });
    const values = valueByWarehouse.get(position.warehouseId) ?? [];
    values.push(onHand.value);
    valueByWarehouse.set(position.warehouseId, values);
  }
  const warehouses = (await runner.execute<{ id: string; code: string; name: string; status: WarehouseStatus }>(sql`
    select w.stock_location_id as id, sl.code, w.name, w.status
      from warehouses w join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
     where w.org_id = ${orgId}
     order by sl.code`)).rows;
  const rows: WarehouseTieOutRow[] = warehouses.map((w) => ({
    warehouseId: w.id,
    code: w.code,
    name: w.name,
    status: w.status,
    value: sum(valueByWarehouse.get(w.id) ?? []),
  }));
  const unassigned = valueByWarehouse.get(null);
  if (unassigned) rows.push({ warehouseId: null, code: null, name: null, status: null, value: sum(unassigned) });
  const accounts = (await runner.execute<{ id: string }>(sql`
    select distinct asset_account_id as id from item_inventory_profiles where org_id = ${orgId} order by 1`)).rows;
  const controlAccountIds = accounts.map((a) => a.id);
  let controlBalance = "0";
  if (controlAccountIds.length > 0) {
    const balance = (await runner.execute<{ balance: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as balance
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounting_books b on b.id = e.book_id and b.org_id = e.org_id and b.is_primary
       where l.org_id = ${orgId}
         and e.status in ('posted', 'reversed')
         and l.account_id in (${sql.join(controlAccountIds.map((id) => sql`${id}::uuid`), sql`, `)})
         ${subsidiaryFilter(sql.raw("e.subsidiary_id"))}`)).rows[0];
    controlBalance = sum([balance?.balance ?? "0"]);
  }
  const layerTotal = sum(rows.map((row) => row.value));
  return { rows, layerTotal, controlBalance, difference: sum([layerTotal, neg(controlBalance)]), controlAccountIds };
}
