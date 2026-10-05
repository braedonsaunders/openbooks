import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, cmp, mulDecimalFactors, neg, normalizeDecimal } from "../money/money.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { salesOrderLineRemainders } from "../records/order-line-remainders.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { toBaseQuantity } from "./costing.ts";
import { isJsonRecord } from "./document-lines.ts";
import { activePickReservations } from "./pick-reservations.ts";
import { kitAvailableFromComponents } from "./kits.ts";
import { getOnHandWith } from "./position.ts";
import { assertWarehousingFeature, listWarehouseLocations, warehouseOf } from "./warehouses.ts";

/**
 * Available to promise: what a legal entity holds, less what its issued
 * sales orders already owe. Every term is an exact base-unit quantity:
 *
 *   available = onHand − committed
 *
 * `onHand` is the sum of `getOnHandWith` over the positions in scope — the
 * same read the posting check makes — never a second SQL sum of layers.
 * `committed` is the open quantity of issued sales-order stock lines placed
 * at those locations, by the one open-quantity rule. Open demand on a line
 * with no stock location is not placed anywhere, so it cannot be netted
 * against any location's stock; it is reported as `unallocated` rather than
 * dropped. An order line raised in another unit is converted exactly as
 * posting converts it, and a unit the item cannot convert is refused by name.
 *
 * `reserved` is informational: the part of `committed` that released, not
 * yet completed pick lists have already allocated to bins. It is a subset of
 * `committed`, never subtracted a second time, so `available` stays
 * `onHand − committed` whether or not the demand has been picked.
 */

export type AvailabilityRefusalCode =
  | "fulfillment_disabled"
  | "subsidiary_not_found"
  | "warehouse_not_found"
  | "item_not_stocked"
  | "unit_not_convertible"
  | "scope_invalid";

/**
 * A named availability refusal. It extends InventoryError so existing
 * inventory error handling still catches it, and carries the HTTP status,
 * a stable code and a remedy naming an action that exists.
 */
export class AvailabilityRefusal extends InventoryError {
  constructor(
    message: string,
    readonly code: AvailabilityRefusalCode,
    readonly remedy: string,
    readonly status: 409 | 422,
  ) {
    super(message);
    this.name = "AvailabilityRefusal";
  }
}

const FULFILLMENT_REMEDY = "turn on Fulfillment in Company Settings → Features";
const COSTING_REMEDY = "the item's Inventory costing section";

/** Backorders are a Fulfillment capability; its switch lives on the Features page. */
export async function assertFulfillmentFeature(runner: Runner, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "fulfillment", runner as SqlExecutor))) {
    throw new AvailabilityRefusal(
      `fulfillment is turned off for this organization; ${FULFILLMENT_REMEDY}`,
      "fulfillment_disabled",
      FULFILLMENT_REMEDY,
      409,
    );
  }
}

/**
 * The legal entity whose stock and demand are measured, and the root entity
 * an order without a subsidiary posts to. Availability is per legal entity
 * because layers are owned per entity.
 */
export async function availabilityEntity(
  runner: Runner,
  orgId: string,
  subsidiaryId: string,
): Promise<{ subsidiaryId: string; rootId: string }> {
  const context = await loadSubsidiaryContext(runner, orgId);
  const subsidiary = context.byId.get(subsidiaryId);
  if (!subsidiary || subsidiary.isElimination) {
    throw new AvailabilityRefusal(
      "subsidiary not found in this organization",
      "subsidiary_not_found",
      "choose an operating subsidiary of this organization",
      422,
    );
  }
  return { subsidiaryId, rootId: context.rootId };
}

/** A stocked item's unit facts and replenishment points. */
export interface StockedItem {
  itemId: string;
  label: string;
  kind: string;
  isActive: boolean;
  baseUnit: string;
  conversions: Record<string, number>;
  /** numeric(19,4) text, or null when unset. */
  reorderPoint: string | null;
  preferredStockLevel: string | null;
}

/** Items with an inventory costing profile, by label; `itemIds` null means all. */
export async function stockedItems(
  runner: Runner,
  orgId: string,
  itemIds: readonly string[] | null,
): Promise<Map<string, StockedItem>> {
  const itemFilter = itemIds === null
    ? sql``
    : itemIds.length === 0
      ? sql`and false`
      : sql`and p.item_id in (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  const rows = (await runner.execute<{
    item_id: string;
    label: string;
    kind: string;
    is_active: boolean;
    base_unit: string;
    unit_conversions: unknown;
    reorder_point: string | null;
    preferred_stock_level: string | null;
  }>(sql`
    select p.item_id, coalesce(nullif(i.code, ''), i.name) as label, i.kind, i.is_active, p.base_unit,
           p.unit_conversions, p.reorder_point::text as reorder_point,
           p.preferred_stock_level::text as preferred_stock_level
      from item_inventory_profiles p
      join items i on i.id = p.item_id and i.org_id = p.org_id
     where p.org_id = ${orgId} ${itemFilter}
     order by 2, 1`)).rows;
  const out = new Map<string, StockedItem>();
  for (const row of rows) {
    const conversions = row.unit_conversions ?? {};
    if (!isJsonRecord(conversions)) {
      throw new AvailabilityRefusal(
        `${row.label}'s unit conversions are malformed`,
        "unit_not_convertible",
        `correct the Unit conversions on ${COSTING_REMEDY}`,
        409,
      );
    }
    out.set(row.item_id, {
      itemId: row.item_id,
      label: row.label,
      kind: row.kind,
      isActive: row.is_active,
      baseUnit: row.base_unit,
      conversions: conversions as Record<string, number>,
      reorderPoint: row.reorder_point === null ? null : normalizeDecimal(row.reorder_point, 4),
      preferredStockLevel: row.preferred_stock_level === null ? null : normalizeDecimal(row.preferred_stock_level, 4),
    });
  }
  return out;
}

/**
 * An order line's open quantity in the item's base unit, converted as posting
 * converts it. Stock is kept to four decimal places, so a finer line quantity
 * cannot be netted against stock and is refused rather than rounded.
 */
export function openBaseQuantity(
  open: string,
  unit: string | null,
  item: StockedItem,
  lineLabel: string,
): string {
  let quantity: string;
  try {
    quantity = normalizeDecimal(open, 4);
  } catch {
    throw new AvailabilityRefusal(
      `${lineLabel} has open quantity ${open}, finer than stock is kept (four decimal places)`,
      "unit_not_convertible",
      "correct the order line's quantity to at most four decimal places",
      409,
    );
  }
  try {
    return toBaseQuantity(quantity, unit, item.conversions, item.baseUnit, lineLabel);
  } catch (error) {
    if (!(error instanceof InventoryError)) throw error;
    throw new AvailabilityRefusal(
      error.message,
      "unit_not_convertible",
      `add the unit under Unit conversions on ${COSTING_REMEDY}, or correct the order line's unit`,
      409,
    );
  }
}

/**
 * The stock locations a warehouse spans: itself and every zone, bin and
 * staging location beneath it.
 */
export async function warehouseLocationSet(
  runner: Runner,
  orgId: string,
  warehouseId: string,
): Promise<Set<string>> {
  const warehouse = (await runner.execute(sql`
    select 1 from warehouses where org_id = ${orgId} and stock_location_id = ${warehouseId}`)).rows[0];
  if (!warehouse) {
    throw new AvailabilityRefusal(
      "warehouse not found in this organization",
      "warehouse_not_found",
      "choose a warehouse listed in Warehouse → Warehouses",
      422,
    );
  }
  const below = await listWarehouseLocations(runner, orgId, warehouseId);
  return new Set([warehouseId, ...below.map((location) => location.id)]);
}

/**
 * Every (item, location) where the entity carries open layers or provisional
 * (negative) stock. Lock-free discovery only: quantities are always re-read
 * through `getOnHandWith`, so an empty position simply contributes zero.
 */
async function stockPositions(
  runner: Runner,
  orgId: string,
  subsidiaryId: string,
  itemIds: readonly string[],
): Promise<Array<{ itemId: string; stockLocationId: string }>> {
  if (itemIds.length === 0) return [];
  const items = sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `);
  return (await runner.execute<{ itemId: string; stockLocationId: string }>(sql`
    select distinct p.item_id as "itemId", p.stock_location_id as "stockLocationId"
      from (
        select item_id, stock_location_id from cost_layers
         where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
           and remaining_quantity <> 0 and item_id in (${items})
        union
        select pc.item_id, pc.stock_location_id
          from inventory_provisional_costs pc
          join inventory_movements mv on mv.id = pc.issue_movement_id and mv.org_id = pc.org_id
         where pc.org_id = ${orgId} and mv.subsidiary_id = ${subsidiaryId}
           and pc.remaining_quantity <> 0 and pc.item_id in (${items})
      ) p
     order by 1, 2`)).rows;
}

/** On-hand quantity per item over the locations in scope (null = every location). */
export async function onHandByItem(
  runner: Runner,
  orgId: string,
  subsidiaryId: string,
  itemIds: readonly string[],
  locations: ReadonlySet<string> | null,
): Promise<Map<string, string>> {
  const onHand = new Map(itemIds.map((id) => [id, "0.0000"]));
  for (const position of await stockPositions(runner, orgId, subsidiaryId, itemIds)) {
    if (locations && !locations.has(position.stockLocationId)) continue;
    const held = await getOnHandWith(runner, orgId, position.itemId, position.stockLocationId, { subsidiaryId });
    onHand.set(position.itemId, add(onHand.get(position.itemId)!, held.quantity));
  }
  return onHand;
}

export interface DemandTerms {
  onHand: string;
  committed: string;
  /** The part of `committed` held on bins by released, open pick lists. */
  reserved: string;
  unallocated: string;
}

/**
 * On hand, committed and unallocated demand for each item, for one entity.
 * An order with no subsidiary counts toward the root entity, the entity its
 * shipment would post to.
 */
export async function demandTermsByItem(
  runner: Runner,
  orgId: string,
  scope: {
    subsidiaryId: string;
    rootId: string;
    items: ReadonlyMap<string, StockedItem>;
    locations: ReadonlySet<string> | null;
  },
): Promise<Map<string, DemandTerms>> {
  const itemIds = [...scope.items.keys()];
  const onHand = await onHandByItem(runner, orgId, scope.subsidiaryId, itemIds, scope.locations);
  const terms = new Map<string, DemandTerms>(
    itemIds.map((id) => [id, { onHand: onHand.get(id)!, committed: "0.0000", reserved: "0.0000", unallocated: "0.0000" }]),
  );
  const lines = await salesOrderLineRemainders(runner as SqlExecutor, orgId, {
    openOnly: true,
    ...(itemIds.length === 1 ? { itemId: itemIds[0] } : {}),
  });
  // Released pick lists hold part of a line's open quantity on bins. The
  // reservation rule already caps it at the line's open quantity, so it is
  // always inside the line's committed demand.
  const held = await activePickReservations(runner as SqlExecutor, orgId, {
    releasedOnly: true,
    salesOrderLineIds: lines.map((line) => line.lineId),
  });
  for (const line of lines) {
    const item = scope.items.get(line.itemId);
    if (!item || (line.subsidiaryId ?? scope.rootId) !== scope.subsidiaryId) continue;
    const entry = terms.get(line.itemId)!;
    const label = `${line.documentNumber} line ${line.lineNumber}`;
    if (line.stockLocationId === null) {
      entry.unallocated = add(entry.unallocated, openBaseQuantity(line.open, line.unit, item, label));
    } else if (!scope.locations || scope.locations.has(line.stockLocationId)) {
      entry.committed = add(entry.committed, openBaseQuantity(line.open, line.unit, item, label));
      for (const reservation of held) {
        // Kit component picks reserve the component, never the kit: only a
        // reservation of the line's own item counts toward its reserved share.
        if (reservation.salesOrderLineId !== line.lineId || reservation.itemId !== line.itemId) continue;
        entry.reserved = add(entry.reserved, openBaseQuantity(reservation.reserved, line.unit, item, label));
      }
    }
  }
  // Kit order lines promise components, not kits: explode their open demand
  // into each component (order-date recipe, kit base units converted exactly
  // like posting converts them) so component availability nets what kits
  // already owe. The kit's own entry keeps the kit-unit demand for display;
  // its available is derived separately below.
  for (const line of lines) {
    const item = scope.items.get(line.itemId);
    if (!item || item.kind !== "kit" || (line.subsidiaryId ?? scope.rootId) !== scope.subsidiaryId) continue;
    if (line.stockLocationId === null) continue;
    if (scope.locations && !scope.locations.has(line.stockLocationId)) continue;
    const label = `${line.documentNumber} line ${line.lineNumber}`;
    const kitOpen = openBaseQuantity(line.open, line.unit, item, label);
    for (const component of await kitBomForDemand(runner, orgId, line.itemId, line.documentDate)) {
      const componentItem = scope.items.get(component.componentItemId);
      if (!componentItem) continue;
      const componentEntry = terms.get(component.componentItemId)!;
      componentEntry.committed = add(
        componentEntry.committed,
        mulDecimalFactors(kitOpen, [component.quantityPer]),
      );
    }
  }
  return terms;
}

/**
 * A kit's plain recipe quantities for demand expansion: order-date windows,
 * manufacturing-only rows excluded like the pick and issue paths exclude
 * them. Read fresh per call — recipes are configuration and this list must
 * never serve a stale one.
 */
async function kitBomForDemand(
  runner: Runner,
  orgId: string,
  kitItemId: string,
  date: string,
): Promise<{ componentItemId: string; quantityPer: string }[]> {
  const rows = (await runner.execute<{ component_item_id: string; quantity_per: string }>(sql`
    select component_item_id, quantity_per::text as quantity_per
      from bom_components
     where org_id = ${orgId} and assembly_item_id = ${kitItemId}
       and operation_seq is null and is_byproduct = false
       and (effective_from is null or effective_from <= ${date}::date)
       and (effective_to is null or ${date}::date < effective_to)
     order by sort_order, component_item_id`)).rows;
  return rows.map((row) => ({ componentItemId: row.component_item_id, quantityPer: row.quantity_per }));
}

export interface AvailableToPromise {
  itemId: string;
  itemLabel: string;
  subsidiaryId: string;
  /** Null when measured over every location the entity holds stock in. */
  warehouseId: string | null;
  baseUnit: string;
  onHand: string;
  committed: string;
  /** Informational: the part of `committed` already picked to bins. */
  reserved: string;
  available: string;
  unallocated: string;
}

export interface AvailabilityQuery {
  subsidiaryId: string;
  warehouseId?: string | null;
  /**
   * Explicit stock locations to measure. A channel push names the mapped
   * stock location directly; warehouse scoping stays the operator-facing
   * path. Both together refuse — one scope decides.
   */
  stockLocationIds?: readonly string[] | null;
}

/** Available to promise for every stocked item (or the listed ones), by label. */
export async function listAvailableToPromise(
  runner: Runner,
  orgId: string,
  query: AvailabilityQuery & { itemIds?: readonly string[] },
): Promise<AvailableToPromise[]> {
  await assertWarehousingFeature(runner, orgId);
  const entity = await availabilityEntity(runner, orgId, query.subsidiaryId);
  const warehouseId = query.warehouseId ?? null;
  const explicit = query.stockLocationIds ?? null;
  if (explicit && warehouseId) {
    throw new AvailabilityRefusal(
      "availability needs one scope: a warehouse or stock locations, not both",
      "scope_invalid",
      "measure one warehouse, or the listed stock locations",
      422,
    );
  }
  const locations = explicit ? new Set(explicit) : warehouseId ? await warehouseLocationSet(runner, orgId, warehouseId) : null;
  const items = await stockedItems(runner, orgId, query.itemIds ?? null);
  if (items.size === 0) return [];
  // Kit derivation needs its components' terms even when the caller asked
  // for the kit alone: union them in so a filtered query still divides by
  // real component availability.
  const kitIds = [...items.values()].filter((item) => item.kind === "kit").map((item) => item.itemId);
  const today = kitIds.length > 0
    ? (await runner.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]?.today
    : null;
  if (kitIds.length > 0) {
    if (!today) throw new InventoryError("cannot determine today's date for kit availability");
    const componentIds = new Set<string>();
    for (const kitId of kitIds) {
      for (const component of await kitBomForDemand(runner, orgId, kitId, today)) {
        componentIds.add(component.componentItemId);
      }
    }
    const missing = [...componentIds].filter((id) => !items.has(id));
    if (missing.length > 0) {
      for (const [id, item] of await stockedItems(runner, orgId, missing)) {
        items.set(id, item);
      }
    }
  }
  const terms = await demandTermsByItem(runner, orgId, { ...entity, items, locations });
  const rows: AvailableToPromise[] = [];
  for (const item of items.values()) {
    if (item.kind === "kit") {
      // Unioned components serve derivation only: list exactly what was asked.
      if (query.itemIds != null && !query.itemIds.includes(item.itemId)) continue;
      rows.push(await kitAvailableToPromise(runner, orgId, { ...entity, locations, warehouseId }, item, terms, today!));
      continue;
    }
    if (query.itemIds != null && !query.itemIds.includes(item.itemId)) continue;
    const entry = terms.get(item.itemId)!;
    rows.push({
      itemId: item.itemId,
      itemLabel: item.label,
      subsidiaryId: entity.subsidiaryId,
      warehouseId,
      baseUnit: item.baseUnit,
      onHand: entry.onHand,
      committed: entry.committed,
      reserved: entry.reserved,
      available: add(entry.onHand, neg(entry.committed)),
      unallocated: entry.unallocated,
    });
  }
  return rows;
}

/**
 * A kit's row: no stock of its own, so on hand reads zero and available is
 * the limiting component's availability divided by its recipe quantity,
 * floored. A kit without an effective recipe, or with a component that
 * carries no costing profile, is misconfigured stock — refuse by name
 * rather than report a zero that reads as correctly nil.
 */
async function kitAvailableToPromise(
  runner: Runner,
  orgId: string,
  scope: { subsidiaryId: string; locations: ReadonlySet<string> | null; warehouseId: string | null },
  item: StockedItem,
  terms: Map<string, DemandTerms>,
  today: string,
): Promise<AvailableToPromise> {
  const recipe = await kitBomForDemand(runner, orgId, item.itemId, today);
  if (recipe.length === 0) {
    throw new AvailabilityRefusal(
      `kit ${item.label} has no bill of materials effective today`,
      "item_not_stocked",
      `add its components before promising it`,
      422,
    );
  }
  const entry = terms.get(item.itemId)!;
  const components = recipe.map((component) => {
    const componentTerms = terms.get(component.componentItemId);
    if (!componentTerms) {
      throw new AvailabilityRefusal(
        `kit ${item.label} contains an item with no inventory costing profile`,
        "item_not_stocked",
        `add an inventory costing profile on ${COSTING_REMEDY}`,
        422,
      );
    }
    return {
      quantityPer: component.quantityPer,
      available: add(componentTerms.onHand, neg(componentTerms.committed)),
    };
  });
  return {
    itemId: item.itemId,
    itemLabel: item.label,
    subsidiaryId: scope.subsidiaryId,
    warehouseId: scope.warehouseId,
    baseUnit: item.baseUnit,
    onHand: "0.0000",
    committed: entry.committed,
    reserved: entry.reserved,
    available: kitAvailableFromComponents(components),
    unallocated: entry.unallocated,
  };
}

/** Available to promise for one item, one entity, and optionally one warehouse. */
export async function getAvailableToPromise(
  runner: Runner,
  orgId: string,
  query: AvailabilityQuery & { itemId: string },
): Promise<AvailableToPromise> {
  const [result] = await listAvailableToPromise(runner, orgId, { ...query, itemIds: [query.itemId] });
  if (!result) {
    throw new AvailabilityRefusal(
      "this item carries no stock: it has no inventory costing profile",
      "item_not_stocked",
      `add an inventory costing profile on ${COSTING_REMEDY}`,
      422,
    );
  }
  return result;
}

export interface ReleasableBackorder {
  documentId: string;
  documentNumber: string;
  documentDate: string;
  lineId: string;
  lineNumber: number;
  itemId: string;
  itemLabel: string;
  customerId: string | null;
  customerName: string | null;
  stockLocationId: string;
  /** The warehouse the line ships from; null for a location in no warehouse. */
  warehouseId: string | null;
  /** The line's open quantity in its own unit, as ordered. */
  unit: string | null;
  open: string;
  baseUnit: string;
  openBase: string;
  /** The part of `openBase` the stock on hand can cover, in the base unit. */
  releasable: string;
}

/**
 * Open sales-order lines that stock on hand could ship now. Each warehouse's
 * on-hand quantity of an item is handed to its open lines in order date, then
 * document number, then line order, and a line is listed with the part the
 * remaining stock covers. The lines are themselves the committed demand, so a
 * line is releasable exactly when stock is still available after every line
 * ahead of it. A location in no warehouse is its own scope.
 *
 * This is a proposal list: nothing is allocated, reserved or shipped.
 */
export async function releasableBackorders(
  runner: Runner,
  orgId: string,
  query: AvailabilityQuery,
): Promise<ReleasableBackorder[]> {
  await assertWarehousingFeature(runner, orgId);
  await assertFulfillmentFeature(runner, orgId);
  const entity = await availabilityEntity(runner, orgId, query.subsidiaryId);
  const warehouseId = query.warehouseId ?? null;
  if (warehouseId) await warehouseLocationSet(runner, orgId, warehouseId);

  const lines = (await salesOrderLineRemainders(runner as SqlExecutor, orgId, { openOnly: true }))
    .filter((line) => line.stockLocationId !== null && (line.subsidiaryId ?? entity.rootId) === entity.subsidiaryId);
  const items = await stockedItems(runner, orgId, [...new Set(lines.map((line) => line.itemId))]);

  // Each location's scope: its warehouse's whole tree, or the location alone.
  const scopeOf = new Map<string, { key: string; warehouseId: string | null; locations: ReadonlySet<string> }>();
  const treeOf = new Map<string, ReadonlySet<string>>();
  for (const line of lines) {
    const location = line.stockLocationId!;
    if (scopeOf.has(location)) continue;
    const warehouse = await warehouseOf(runner, orgId, location);
    if (warehouse) {
      if (!treeOf.has(warehouse.id)) treeOf.set(warehouse.id, await warehouseLocationSet(runner, orgId, warehouse.id));
      scopeOf.set(location, { key: warehouse.id, warehouseId: warehouse.id, locations: treeOf.get(warehouse.id)! });
    } else {
      scopeOf.set(location, { key: location, warehouseId: null, locations: new Set([location]) });
    }
  }

  const inScope = lines.filter((line) => !warehouseId || scopeOf.get(line.stockLocationId!)!.warehouseId === warehouseId);
  const remaining = new Map<string, string>();
  const releasable: Array<Omit<ReleasableBackorder, "customerName">> = [];
  for (const line of inScope) {
    const item = items.get(line.itemId)!;
    const scope = scopeOf.get(line.stockLocationId!)!;
    const key = `${scope.key}:${line.itemId}`;
    if (!remaining.has(key)) {
      const onHand = await onHandByItem(runner, orgId, entity.subsidiaryId, [line.itemId], scope.locations);
      remaining.set(key, onHand.get(line.itemId)!);
    }
    const supply = remaining.get(key)!;
    const openBase = openBaseQuantity(line.open, line.unit, item, `${line.documentNumber} line ${line.lineNumber}`);
    if (cmp(supply, "0") <= 0) continue;
    const covered = cmp(openBase, supply) <= 0 ? openBase : supply;
    remaining.set(key, add(supply, neg(covered)));
    releasable.push({
      documentId: line.documentId,
      documentNumber: line.documentNumber,
      documentDate: line.documentDate,
      lineId: line.lineId,
      lineNumber: line.lineNumber,
      itemId: line.itemId,
      itemLabel: item.label,
      customerId: line.customerId,
      stockLocationId: line.stockLocationId!,
      warehouseId: scope.warehouseId,
      unit: line.unit,
      open: line.open,
      baseUnit: item.baseUnit,
      openBase,
      releasable: covered,
    });
  }

  const customerIds = [...new Set(releasable.map((line) => line.customerId).filter((id): id is string => id !== null))];
  const names = customerIds.length === 0
    ? new Map<string, string>()
    : new Map((await runner.execute<{ id: string; name: string }>(sql`
        select id, display_name as name from parties
         where org_id = ${orgId} and id in (${sql.join(customerIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows
        .map((row) => [row.id, row.name]));
  return releasable.map((line) => ({ ...line, customerName: line.customerId ? names.get(line.customerId) ?? null : null }));
}
