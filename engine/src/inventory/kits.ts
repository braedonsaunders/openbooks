import { sql } from "drizzle-orm";
import { fromUnits, mulDecimalFactors, toUnits } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { isJsonRecord } from "./document-lines.ts";

/**
 * Kits as virtual bundles.
 *
 * A `kit` item holds no stock of its own: its bill of materials (the same
 * `bom_components` table assemblies use, keyed on the kit item) names the
 * stocked components a sale issues, a return restores, and availability
 * derives from. Pricing and revenue stay on the kit line; only the stock
 * legs explode. Revenue allocation to components is out of scope.
 */

// ---------------------------------------------------------------------------
// Kind + refusal
// ---------------------------------------------------------------------------

/** The item kind of each listed item. */
export async function itemKinds(
  runner: Runner,
  orgId: string,
  itemIds: readonly string[],
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = (await runner.execute<{ id: string; kind: string }>(sql`
    select id, kind from items
     where org_id = ${orgId}
       and id in (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows;
  return new Map(rows.map((row) => [row.id, row.kind]));
}

/**
 * Whether a kit component moves stock when its kit sells or is returned.
 * Only stocked kinds (`inventory`, `assembly`) issue and receive movements;
 * service, non-inventory and charge components are commercial-only lines on
 * the kit's recipe and never touch the shelf. One predicate serves the sale
 * explosion, the return guard and the channel refund builder, so a component
 * the sale skipped can never be demanded back by the return.
 */
export function kitComponentMovesStock(kind: string): boolean {
  return kind === "inventory" || kind === "assembly";
}

/** Display label for a kit refusal: code when set, else name, else id. */
export async function kitLabel(
  runner: Runner,
  orgId: string,
  itemId: string,
): Promise<string> {
  const row = (await runner.execute<{ code: string | null; name: string }>(sql`
    select code, name from items where org_id = ${orgId} and id = ${itemId}`)).rows[0];
  if (!row) return itemId;
  return row.code?.trim() || row.name || itemId;
}

/**
 * Kits hold no stock: receiving, adjusting, counting or building one mints
 * a position that can never be valued or shipped. Refuse by name and point
 * at the components, which are the only stocked side of a kit.
 */
export function kitNoStockRefusal(label: string, verb: "receive" | "adjust" | "build" | "count"): string {
  const action = verb === "receive" ? "receive" : verb === "adjust" ? "adjust" : verb === "build" ? "build" : "count";
  return (
    `kits hold no stock; receive the components — ` +
    `kit ${label} cannot be ${action === "build" ? "built into stock" : `${action}ed`}. ` +
    `Sell the kit and its components issue automatically, or stock the components directly.`
  );
}

/** Refuse when the item is a kit; a no-op for every other kind. */
export async function assertNotKitItem(
  runner: Runner,
  orgId: string,
  itemId: string,
  verb: "receive" | "adjust" | "build" | "count",
): Promise<void> {
  const kinds = await itemKinds(runner, orgId, [itemId]);
  if (kinds.get(itemId) !== "kit") return;
  throw new InventoryError(kitNoStockRefusal(await kitLabel(runner, orgId, itemId), verb));
}

// ---------------------------------------------------------------------------
// Bill of materials shared by explosion, returns and availability
// ---------------------------------------------------------------------------

export interface KitComponent {
  componentItemId: string;
  componentKind: string;
  /** Base-unit quantity per one kit, exact four-decimal text. */
  quantityPer: string;
  sortOrder: number;
}

/**
 * A kit's components effective on a date, in recipe order. The same
 * effectivity predicate the assembly build uses: a row applies when its
 * window contains the movement date. Manufacturing-only recipe features
 * (operations, by-products, scrap) are refused at the BOM save, so the
 * rows read here are plain per-kit quantities — but a row carrying them
 * from another writer is refused rather than silently applied.
 */
export async function loadKitComponents(
  runner: Runner,
  orgId: string,
  kitItemId: string,
  date: string,
): Promise<KitComponent[]> {
  const rows = (await runner.execute<{
    component_item_id: string;
    component_kind: string;
    quantity_per: string;
    sort_order: number;
    operation_seq: number | null;
    scrap_pct: string | null;
    is_byproduct: boolean;
  }>(sql`
    select b.component_item_id, component.kind as component_kind,
           b.quantity_per::text as quantity_per, b.sort_order,
           b.operation_seq, b.scrap_pct::text as scrap_pct, b.is_byproduct
      from bom_components b
      join items component on component.org_id = b.org_id and component.id = b.component_item_id
     where b.org_id = ${orgId} and b.assembly_item_id = ${kitItemId}
       and (b.effective_from is null or b.effective_from <= ${date}::date)
       and (b.effective_to is null or ${date}::date < b.effective_to)
     order by b.sort_order, b.component_item_id`)).rows;
  if (rows.length === 0) {
    throw new InventoryError(
      `kit ${await kitLabel(runner, orgId, kitItemId)} has no bill of materials effective on ${date}; ` +
        `add its components before selling it`,
    );
  }
  const parent = await kitLabel(runner, orgId, kitItemId);
  const nested = rows.find((row) => row.component_kind === "kit");
  if (nested) {
    throw new InventoryError(
      `kit ${parent} contains kit ${await kitLabel(runner, orgId, nested.component_item_id)}; ` +
        `kits cannot contain other kits — list ${await kitLabel(runner, orgId, nested.component_item_id)}'s components directly instead`,
    );
  }
  // An explicit zero scrap rate changes nothing, so only a nonzero rate —
  // or any operation or by-product row — is a manufacturing feature here.
  const manufactured = rows.find(
    (row) =>
      row.operation_seq !== null || row.is_byproduct || (row.scrap_pct !== null && toUnits(row.scrap_pct) !== 0n),
  );
  if (manufactured) {
    throw new InventoryError(
      `kit ${parent} names a manufacturing recipe feature on ${await kitLabel(runner, orgId, manufactured.component_item_id)}; ` +
        `kits ship exactly the quantities named — remove the operation, by-product or scrap rate from the recipe`,
    );
  }
  return rows.map((row) => ({
    componentItemId: row.component_item_id,
    componentKind: row.component_kind,
    quantityPer: row.quantity_per,
    sortOrder: row.sort_order,
  }));
}

export interface KitComponentQuantity {
  componentItemId: string;
  /** Base-unit quantity for the whole kit line, exact four-decimal text. */
  quantity: string;
}

/**
 * One kit line's per-component quantities: line quantity × quantity per,
 * decimal-exact to inventory precision. A product that rounds to zero is a
 * recipe below what stock can represent — refuse by name rather than issue
 * nothing and report success.
 */
export function kitComponentQuantities(
  kitLabelText: string,
  lineQuantity: string,
  components: readonly KitComponent[],
): KitComponentQuantity[] {
  return components.map((component) => {
    const quantity = mulDecimalFactors(lineQuantity, [component.quantityPer]);
    if (toUnits(quantity) === 0n && toUnits(lineQuantity) !== 0n) {
      throw new InventoryError(
        `kit ${kitLabelText} needs ${component.quantityPer} of component ${component.componentItemId} per kit, ` +
          `below the 0.0001 unit precision at this quantity — sell a larger quantity or adjust the recipe`,
      );
    }
    return { componentItemId: component.componentItemId, quantity };
  });
}

// ---------------------------------------------------------------------------
// Idempotency: one effect per (document line, component)
// ---------------------------------------------------------------------------

/**
 * A kit line issues one movement per component, so the posting-effect key
 * carries the component: re-running the drain finds each component's
 * movement and is a no-op, exactly like the single-issue key it extends.
 */
export function inventoryKitComponentEffectKey(
  documentLineId: string,
  componentItemId: string,
): string {
  return `posting-effect:inventory:issue:document-line:${documentLineId}:component:${componentItemId}`;
}

/** The return-side mirror: one receipt per returned component. */
export function inventoryKitComponentReturnKey(
  documentLineId: string,
  componentItemId: string,
): string {
  return `posting-effect:inventory:return:document-line:${documentLineId}:component:${componentItemId}`;
}

// ---------------------------------------------------------------------------
// Availability: floor of the component minimum
// ---------------------------------------------------------------------------

/**
 * Kit available-to-promise from one component's availability: how many whole
 * kits the component covers, rounded DOWN to whole kits. Division is exact
 * bigint math — never a float — and a negative component availability floors
 * negative, like the stocked-item available it derives from.
 */
export function floorKitQuantity(componentAvailable: string, quantityPer: string): string {
  const availableUnits = toUnits(componentAvailable);
  const perUnits = toUnits(quantityPer);
  if (perUnits <= 0n) {
    throw new InventoryError(`kit recipe quantity must be positive, found ${quantityPer}`);
  }
  const truncated = availableUnits / perUnits;
  const remainder = availableUnits % perUnits;
  const whole = remainder === 0n || availableUnits >= 0n ? truncated : truncated - 1n;
  return fromUnits(whole * 10000n);
}

/**
 * Kit available-to-promise per location: the limiting component decides.
 * Every component availability is in its own base unit; dividing by its
 * per-kit quantity converts each to kits before the minimum is taken.
 */
export function kitAvailableFromComponents(
  components: readonly { quantityPer: string; available: string }[],
): string {
  let limiting: string | null = null;
  for (const component of components) {
    const kits = floorKitQuantity(component.available, component.quantityPer);
    if (limiting === null || toUnits(kits) < toUnits(limiting)) limiting = kits;
  }
  if (limiting === null) {
    throw new InventoryError("a kit with no components has no availability");
  }
  return limiting;
}

// ---------------------------------------------------------------------------
// Shipment evidence: per-component lots, serials and bins
// ---------------------------------------------------------------------------

export interface KitComponentPick {
  componentItemId: string;
  lotId: string | null;
  serialId: string | null;
  stockLocationId: string | null;
}

/**
 * Per-component picks carried on a kit fulfillment line
 * (`custom.fulfillment.kitComponents`). Quantities are never stored here:
 * the issue re-derives them as line quantity × quantity per, so evidence
 * and recipe cannot disagree. Each entry names at most one lot or serial
 * and optionally the bin the component issues from (defaulting to the
 * kit line's own stock location).
 */
export function parseKitComponentPicks(
  custom: unknown,
  lineLabel: string,
): KitComponentPick[] | null {
  const evidence = isJsonRecord(custom) ? custom.fulfillment : null;
  if (!isJsonRecord(evidence)) return null;
  const picks = evidence.kitComponents;
  if (picks === undefined || picks === null) return null;
  if (!Array.isArray(picks)) {
    throw new InventoryError(`${lineLabel} kit component picks must be a list`);
  }
  return picks.map((pick, index) => {
    const label = `${lineLabel} kit component ${index + 1}`;
    if (!isJsonRecord(pick)) {
      throw new InventoryError(`${label} must name a component item`);
    }
    const componentItemId = pick.componentItemId;
    const lotId = pick.lotId ?? null;
    const serialId = pick.serialId ?? null;
    const stockLocationId = pick.stockLocationId ?? null;
    if (typeof componentItemId !== "string" || !isUuid(componentItemId)) {
      throw new InventoryError(`${label} requires a valid component item`);
    }
    if (lotId !== null && (typeof lotId !== "string" || !isUuid(lotId))) {
      throw new InventoryError(`${label} lotId must be a UUID`);
    }
    if (serialId !== null && (typeof serialId !== "string" || !isUuid(serialId))) {
      throw new InventoryError(`${label} serialId must be a UUID`);
    }
    if (stockLocationId !== null && (typeof stockLocationId !== "string" || !isUuid(stockLocationId))) {
      throw new InventoryError(`${label} stockLocationId must be a UUID`);
    }
    if (lotId !== null && serialId !== null) {
      throw new InventoryError(`${label} cannot name both a lot and a serial`);
    }
    return { componentItemId, lotId, serialId, stockLocationId };
  });
}

// ---------------------------------------------------------------------------
// Return evidence: per-component source issues
// ---------------------------------------------------------------------------

export interface KitComponentReturnSource {
  sourceIssueMovementId: string;
  lotId: string | null;
  serialId: string | null;
}

/**
 * Per-component source issues carried on a kit customer-credit line
 * (`custom.inventoryReturn.kitComponents`). One kit sale issues one
 * movement per component, so one kit return names one source movement per
 * component — the movement that carries the cost the return restores.
 */
export function parseKitComponentReturnSources(
  custom: unknown,
  lineLabel: string,
): KitComponentReturnSource[] {
  const evidence = isJsonRecord(custom) ? custom.inventoryReturn : null;
  if (!isJsonRecord(evidence)) {
    throw new InventoryError(
      `${lineLabel} is a kit: choose the source shipment for every stocked component, ` +
        `or post the credit with no goods returned`,
    );
  }
  const sources = evidence.kitComponents;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new InventoryError(
      `${lineLabel} is a kit: name one source shipment per component in inventoryReturn.kitComponents`,
    );
  }
  return sources.map((source, index) => {
    const label = `${lineLabel} kit component ${index + 1}`;
    if (!isJsonRecord(source)) {
      throw new InventoryError(`${label} must name a source shipment`);
    }
    const sourceIssueMovementId = source.sourceIssueMovementId;
    const lotId = source.lotId ?? null;
    const serialId = source.serialId ?? null;
    if (typeof sourceIssueMovementId !== "string" || !isUuid(sourceIssueMovementId)) {
      throw new InventoryError(`${label} requires a valid inventoryReturn sourceIssueMovementId`);
    }
    if (lotId !== null && (typeof lotId !== "string" || !isUuid(lotId))) {
      throw new InventoryError(`${label} inventoryReturn.lotId must be a UUID`);
    }
    if (serialId !== null && (typeof serialId !== "string" || !isUuid(serialId))) {
      throw new InventoryError(`${label} inventoryReturn.serialId must be a UUID`);
    }
    return { sourceIssueMovementId, lotId, serialId };
  });
}
