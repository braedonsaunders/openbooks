import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import {
  AvailabilityRefusal,
  listAvailableToPromise,
  openBaseQuantity,
  purchaseOrderLineRemainders,
  stockedItems,
  warehouseOf,
  type AvailableToPromise,
} from "@openbooks/engine/inventory";
import { add } from "@openbooks/engine/money";
import { normalizeMoneyValue } from "../cash/core";
import { isFeatureEnabled } from "../features";
import { clamp, isUuid } from "../list-params";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, conflict, invalidInput } from "./errors";

/**
 * On-hand stock from open cost layers — the same source as the native
 * on-hand list and the GL tie-out (layers carry every revaluation: NRV
 * writedowns and landed-cost adjustments rewrite layers plus GL and write
 * no movement rows, so a movement sum permanently overstates value after
 * either). Quantity and value come from the one source together.
 */
export async function listApplicationInventoryLevels(
  context: ApplicationContext,
  input: { itemId?: string; stockLocationId?: string; limit?: number },
) {
  assertApplicationPermission(context, "items.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "inventory"))) {
    throw new ApplicationError(
      "not_found",
      "inventory is off; enable it from GET /api/v1/settings/features",
      404,
    );
  }
  const limit = clamp(input.limit ?? 50, 1, 200);
  const scope = subsidiaryVisibleFilter(sql`l.subsidiary_id`, context.authz.allowedSubsidiaryIds);
  let where = sql`l.org_id = ${context.authz.user.orgId} and l.remaining_quantity > 0 ${scope}`;
  if (input.itemId) where = sql`${where} and l.item_id = ${input.itemId}`;
  if (input.stockLocationId) where = sql`${where} and l.stock_location_id = ${input.stockLocationId}`;
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select i.id as item_id, i.code as item_code, i.name as item_name,
           sl.id as stock_location_id, sl.code as stock_location_code,
           coalesce(sum(l.remaining_quantity), 0)::text as quantity,
           coalesce(sum(round(l.remaining_quantity * l.unit_cost, 4)), 0)::text as value
      from cost_layers l
      join items i on i.id = l.item_id and i.org_id = l.org_id
      left join stock_locations sl on sl.id = l.stock_location_id and sl.org_id = l.org_id
     where ${where}
     group by i.id, i.code, i.name, sl.id, sl.code
    having coalesce(sum(l.remaining_quantity), 0) <> 0
     order by i.name, sl.code
     limit ${limit}`)).rows;
  const totals = (await db.execute<{ lines: number; quantity: string; value: string }>(sql`
    select count(*)::int as lines,
           coalesce(sum(sub.quantity), 0)::text as quantity,
           coalesce(sum(sub.value), 0)::text as value
      from (
        select sum(l.remaining_quantity) as quantity, sum(round(l.remaining_quantity * l.unit_cost, 4)) as value
          from cost_layers l
         where ${where}
         group by l.item_id, l.stock_location_id
        having coalesce(sum(l.remaining_quantity), 0) <> 0
      ) sub`)).rows[0];
  return {
    total: Number(totals?.lines ?? 0),
    sumQuantity: totals?.quantity ?? "0",
    sumValue: normalizeMoneyValue(String(totals?.value ?? "0")),
    levels: rows.map((row) => ({
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      stockLocationId: row.stock_location_id,
      stockLocationCode: row.stock_location_code,
      quantity: String(row.quantity ?? "0"),
      value: normalizeMoneyValue(String(row.value ?? "0")),
    })),
  };
}

export interface AvailableInventoryFilters {
  subsidiaryId?: string;
  itemIds?: string[];
  itemCodes?: string[];
  locationIds?: string[];
  changedSince?: string;
  limit?: number;
}

export interface AvailableInventoryRow {
  itemId: string;
  itemCode: string | null;
  itemName: string;
  subsidiaryId: string;
  warehouseId: string | null;
  warehouseName: string | null;
  baseUnit: string;
  onHand: string;
  committed: string;
  incoming: string;
  available: string;
}

function availabilityRefusal(error: unknown): never {
  if (error instanceof AvailabilityRefusal) {
    const details = { code: error.code, remedy: error.remedy };
    if (error.status === 409) throw conflict(error.message, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

/**
 * Promisable stock per item and warehouse for storefronts and replenishment
 * sync: on hand, committed and available come from the availability engine —
 * the same computation the native availability report renders — while
 * incoming nets approved purchase-order lines still on order, converted to
 * the item's base unit exactly as posting converts them.
 */
export async function listAvailableApplicationInventory(
  context: ApplicationContext,
  filters: AvailableInventoryFilters,
): Promise<{ subsidiaryId: string; rows: AvailableInventoryRow[] }> {
  assertApplicationPermission(context, "items.read");
  const orgId = context.authz.user.orgId;
  if (!(await isFeatureEnabled(orgId, "inventory"))) {
    throw new ApplicationError(
      "not_found",
      "inventory is off; enable it from GET /api/v1/settings/features",
      404,
    );
  }

  const subsidiaryId = await resolveAvailableSubsidiary(context, filters.subsidiaryId);
  assertSubsidiaryAccess(context, subsidiaryId);

  const itemIds = await resolveAvailableItems(orgId, filters);
  const warehouses = await resolveAvailableWarehouses(orgId, filters.locationIds);

  // One availability read per warehouse (null measures the whole entity);
  // the engine unions kit components itself, so filtered kits still divide
  // by real component availability.
  const terms: AvailableToPromise[] = [];
  try {
    for (const warehouseId of warehouses) {
      terms.push(
        ...(await listAvailableToPromise(db, orgId, {
          subsidiaryId,
          warehouseId,
          ...(itemIds ? { itemIds } : {}),
        })),
      );
    }
  } catch (error) {
    availabilityRefusal(error);
  }

  const incoming = await incomingByItemWarehouse(orgId, itemIds, terms);
  const limit = clamp(filters.limit ?? 200, 1, 500);
  const rows = terms.slice(0, limit).map((term) => ({
    itemId: term.itemId,
    itemCode: null as string | null,
    itemName: term.itemLabel,
    subsidiaryId: term.subsidiaryId,
    warehouseId: term.warehouseId,
    warehouseName: null as string | null,
    baseUnit: term.baseUnit,
    onHand: term.onHand,
    committed: term.committed,
    incoming: incoming.get(`${term.itemId}::${term.warehouseId ?? ""}`) ?? "0",
    available: term.available,
  }));

  // Names ride one query each, never per row.
  if (rows.length > 0) {
    const itemNames = (await db.execute<{ id: string; code: string | null; name: string }>(sql`
      select id, code, name from items
       where org_id = ${orgId} and id in (${sql.join([...new Set(rows.map((row) => row.itemId))].map((id) => sql`${id}::uuid`), sql`, `)})`)).rows;
    const byItem = new Map(itemNames.map((item) => [item.id, item]));
    const warehouseIds = [...new Set(rows.map((row) => row.warehouseId).filter((id) => id !== null))];
    const byWarehouse =
      warehouseIds.length > 0
        ? new Map(
            (await db.execute<{ id: string; name: string }>(sql`
              select sl.id, coalesce(w.name, sl.code, sl.id::text) as name
                from stock_locations sl
                left join warehouses w on w.stock_location_id = sl.id and w.org_id = sl.org_id
               where sl.org_id = ${orgId} and sl.id in (${sql.join(warehouseIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows.map(
              (warehouse) => [warehouse.id, warehouse.name] as const,
            ),
          )
        : new Map<string, string>();
    for (const row of rows) {
      const item = byItem.get(row.itemId);
      row.itemCode = item?.code ?? null;
      row.itemName = item?.name ?? row.itemName;
      row.warehouseName = row.warehouseId ? (byWarehouse.get(row.warehouseId) ?? null) : null;
    }
  }
  return { subsidiaryId, rows };
}

/**
 * Stock is owned per legal entity, so the caller names one — defaulting to
 * the only operating subsidiary when there is exactly one, and refusing an
 * ambiguous default naming the choice instead of guessing it.
 */
async function resolveAvailableSubsidiary(
  context: ApplicationContext,
  requested: string | undefined,
): Promise<string> {
  const orgId = context.authz.user.orgId;
  if (requested !== undefined) {
    if (!isUuid(requested)) throw invalidInput("subsidiaryId must be a UUID");
    return requested;
  }
  // A restricted key only ever defaults inside its own fence.
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed && allowed.size === 0) {
    throw invalidInput("this API key cannot see any subsidiary — widen its scope first");
  }
  const operating = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${orgId} and not is_elimination and is_active
       ${allowed ? sql`and id in (${sql.join([...allowed].map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
     order by id`)).rows;
  if (operating.length === 1 && operating[0]) return operating[0].id;
  throw invalidInput(
    operating.length === 0
      ? "this organization has no operating subsidiary — create one before promising stock"
      : "this organization has several operating subsidiaries — send the subsidiaryId whose stock you are promising",
  );
}

/**
 * Item filters resolve to profiled ids before the engine runs: unknown ids
 * and codes are refused by name (a silent empty list would read as
 * correctly nil), and changedSince bounds the sync on the item's own
 * revision timestamp.
 */
async function resolveAvailableItems(
  orgId: string,
  filters: AvailableInventoryFilters,
): Promise<string[] | null> {
  const ids = filters.itemIds ?? [];
  const codes = filters.itemCodes ?? [];
  for (const id of ids) {
    if (!isUuid(id)) throw invalidInput(`item "${id}" is not a UUID — send item ids or codes`);
  }
  let since: string | null = null;
  if (filters.changedSince !== undefined) {
    const parsed = Date.parse(filters.changedSince);
    if (Number.isNaN(parsed)) {
      throw invalidInput(
        `changedSince "${filters.changedSince}" is not a date — send an ISO 8601 timestamp`,
      );
    }
    since = new Date(parsed).toISOString();
  }
  if (ids.length === 0 && codes.length === 0 && since === null) return null;
  // Existence first, independent of the date bound: an unknown id or code
  // is refused by name, while a date that narrows everything out is an
  // honest empty list.
  const matched = (await db.execute<{ id: string; code: string | null }>(sql`
    select i.id, i.code from items i
     where i.org_id = ${orgId}
       ${ids.length > 0 || codes.length > 0 ? sql`and (` : sql``}
       ${ids.length > 0 ? sql`i.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
       ${ids.length > 0 && codes.length > 0 ? sql`or ` : sql``}
       ${codes.length > 0 ? sql`i.code in (${sql.join(codes.map((code) => sql`${code}`), sql`, `)})` : sql``}
       ${ids.length > 0 || codes.length > 0 ? sql`)` : sql``}`)).rows;
  for (const id of ids) {
    if (!matched.some((row) => row.id === id)) {
      throw invalidInput(`item id "${id}" not found in this organization — check the id or sync the item first`);
    }
  }
  for (const code of codes) {
    if (!matched.some((row) => row.code === code)) {
      throw invalidInput(`item code "${code}" not found in this organization — check the code or sync the item first`);
    }
  }
  if (since === null) return matched.map((row) => row.id);
  if (matched.length === 0) return [];
  const fresh = (await db.execute<{ id: string }>(sql`
    select id from items
     where org_id = ${orgId}
       and id in (${sql.join(matched.map((row) => sql`${row.id}::uuid`), sql`, `)})
       and updated_at >= ${since}::timestamptz`)).rows.map((row) => row.id);
  return fresh;
}

/**
 * Location filters name warehouses, or the stock locations inside them
 * (bins and staging resolve to their warehouse). Unknown locations are
 * refused by name; an empty filter measures the whole entity as one row
 * per item, exactly as the engine does unscoped.
 */
async function resolveAvailableWarehouses(
  orgId: string,
  locationIds: string[] | undefined,
): Promise<Array<string | null>> {
  if (!locationIds || locationIds.length === 0) return [null];
  for (const id of locationIds) {
    if (!isUuid(id)) throw invalidInput(`location "${id}" is not a UUID`);
  }
  // warehouseOf answers null for unknown locations rather than throwing;
  // anything else it raises is a genuine failure, not a refusal. An
  // unknown location must fail closed, never silently measure the entity.
  const out: Array<string | null> = [];
  for (const id of locationIds) {
    const warehouse = await warehouseOf(db, orgId, id);
    if (!warehouse) throw invalidInput(`location "${id}" not found in this organization`);
    if (!out.includes(warehouse.id)) out.push(warehouse.id);
  }
  return out;
}

/**
 * Approved purchase-order lines still on order, grouped by item and
 * warehouse in base units. Lines with no directed location belong to no
 * warehouse: they count toward the entity-wide row only.
 */
async function incomingByItemWarehouse(
  orgId: string,
  itemIds: string[] | null,
  terms: AvailableToPromise[],
): Promise<Map<string, string>> {
  const wanted = new Set(terms.map((term) => `${term.itemId}::${term.warehouseId ?? ""}`));
  const out = new Map<string, string>();
  if (terms.length === 0) return out;
  const remainderItems = [...new Set(terms.map((term) => term.itemId))];
  const units = await stockedItems(db, orgId, remainderItems.length > 0 ? remainderItems : null);
  const lines =
    itemIds !== null && itemIds.length > 0
      ? (
          await Promise.all(
            itemIds.map((itemId) => purchaseOrderLineRemainders(db, orgId, { itemId, openOnly: true })),
          )
        ).flat()
      : await purchaseOrderLineRemainders(db, orgId, { openOnly: true });
  // An entity-wide row promises every directed line too: supply aimed at a
  // warehouse is supply the entity can move. Warehouse rows count only
  // their own locations; undirected lines belong to no warehouse.
  const wantedNull = new Set(
    [...wanted].filter((key) => key.endsWith("::")).map((key) => key.slice(0, -2)),
  );
  const warehouseCache = new Map<string, string | null>();
  for (const line of lines) {
    const base = openBase(line, units);
    let warehouseId: string | null = null;
    if (line.stockLocationId) {
      const cached = warehouseCache.get(line.stockLocationId);
      if (cached !== undefined) {
        warehouseId = cached;
      } else {
        const warehouse = await warehouseOf(db, orgId, line.stockLocationId);
        warehouseId = warehouse ? warehouse.id : null;
        warehouseCache.set(line.stockLocationId, warehouseId);
      }
    }
    if (warehouseId) {
      const key = `${line.itemId}::${warehouseId}`;
      if (wanted.has(key)) out.set(key, add(out.get(key) ?? "0", base));
    }
    if (wantedNull.has(line.itemId)) {
      const key = `${line.itemId}::`;
      out.set(key, add(out.get(key) ?? "0", base));
    }
  }
  return out;

  function openBase(
    line: { itemId: string; open: string; unit: string | null; documentNumber: string; lineNumber: number },
    stocked: Awaited<ReturnType<typeof stockedItems>>,
  ): string {
    const item = stocked.get(line.itemId);
    if (!item) return "0";
    try {
      return openBaseQuantity(line.open, line.unit, item, `${line.documentNumber} line ${line.lineNumber}`);
    } catch {
      // A line posting refused: it cannot promise supply either, so it
      // contributes nothing rather than a rounded something.
      return "0";
    }
  }
}
