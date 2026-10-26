import "server-only";
import { db } from "@openbooks/engine/platform/db";
import { fromQuantityUnits, toQuantityUnits } from "./order-cycle-math";
import { WarehouseRefusal, ensureDefaultWarehouse } from "@openbooks/engine/inventory/warehouses";

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

/** Machine-readable code for a goods receipt refused over a missing RNB account. */
export const ITEM_MISSING_RNB_ACCOUNT = "ITEM_MISSING_RNB_ACCOUNT";

/**
 * Machine-readable code for a fulfillment/receipt refused because a stocked
 * order line has no warehouse and the org has no single default to fall
 * back to. Details carry the offending lineNumber and the
 * active warehouse count the message was built from.
 */
export const ORDER_LINE_WAREHOUSE_REQUIRED = "ORDER_LINE_WAREHOUSE_REQUIRED";

/** Machine-readable code for a fulfilment line naming a bin outside the
 *  order line's warehouse. */
export const FULFILLMENT_BIN_OUTSIDE_WAREHOUSE = "FULFILLMENT_BIN_OUTSIDE_WAREHOUSE";

export interface UnwarehousedOrderLine {
  lineNumber: number;
  itemId: string | null;
}

/**
 * Selected order lines that cannot ship or receive: stocked (profiled)
 * lines with no warehouse when the warehouse choice is ambiguous. With
 * exactly one active warehouse the posting reader falls back silently, so
 * there is nothing to refuse. Pure so the rule is unit-testable; the
 * fulfillment/receipt writers throw the refusal.
 */
export function missingOrderLineWarehouses(
  lines: {
    lineNumber: number;
    itemId: string | null;
    hasInventoryProfile: boolean;
    stockLocationId: string | null;
  }[],
  activeWarehouseCount: number,
): UnwarehousedOrderLine[] {
  if (activeWarehouseCount === 1) return [];
  return lines
    .filter((line) => line.hasInventoryProfile && !line.stockLocationId)
    .map((line) => ({ lineNumber: line.lineNumber, itemId: line.itemId }));
}

/**
 * Stamp the entity's default warehouse onto blank stocked lines
 * (designated default first, then the implicit single; a first receipt for
 * a single-site org with no warehouse yet creates it). In-memory only: the
 * converted receipt/fulfillment lines carry it forward while approved
 * source lines stay untouched. Lines that already name a warehouse keep it.
 */
export async function stampDefaultWarehouse(
  tx: OrderCycleTx,
  orgId: string,
  userId: string,
  subsidiaryId: string | null,
  lines: {
    item_id: string | null;
    has_inventory_profile: boolean;
    stock_location_id: string | null;
  }[],
): Promise<void> {
  if (!lines.some((line) => line.item_id && line.has_inventory_profile && !line.stock_location_id))
    return;
  let defaultWarehouseId: string | null;
  try {
    defaultWarehouseId = await ensureDefaultWarehouse(tx, orgId, userId, subsidiaryId);
  } catch (error) {
    // A dead designation or a disabled feature refuses typed with its
    // remedy — never as an unexpected server failure.
    if (error instanceof WarehouseRefusal) {
      throw new ConversionError(error.message, error.status, error.code, { remedy: error.remedy });
    }
    throw error;
  }
  if (!defaultWarehouseId) return;
  for (const line of lines) {
    if (line.item_id && line.has_inventory_profile && !line.stock_location_id) {
      line.stock_location_id = defaultWarehouseId;
    }
  }
}

export const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

/**
 * One open order line that a receipt- or shipment-governed billing
 * conversion could not carry in full. A purchase order bills stock only up to
 * its received-and-unbilled quantity and a sales order only up to its
 * shipped-and-unbilled quantity; the rest stays open on the order and is
 * reported here, never dropped silently. Quantities are exact decimal
 * strings; amounts are ledger money in the order currency.
 */
export interface ConversionWithheldLine {
  lineNumber: number;
  sourceLineId: string;
  itemId: string | null;
  itemName: string | null;
  description: string | null;
  unit: string | null;
  orderedQuantity: string;
  cancelledQuantity: string;
  /** Received on a purchase order, shipped on a sales order. */
  fulfilledQuantity: string;
  /** Billed by earlier conversions or captures, before this one. */
  previouslyBilledQuantity: string;
  convertedQuantity: string;
  withheldQuantity: string;
  withheldAmount: string;
  withheldTaxAmount: string;
  reason: "awaiting_receipt" | "awaiting_shipment";
}

export interface ConvertResult {
  id: string;
  documentNumber: string;
  kind: string;
  replayed?: boolean;
  /** Open lines this conversion did not carry in full; absent when every
   *  open line converted completely. */
  withheldLines?: ConversionWithheldLine[];
  /** Amount plus tax of the withheld quantities: the exact difference between
   *  the order's open total and the new document's total. */
  withheldTotal?: string;
}

/** Machine-readable code: a billing conversion would carry an inventory item
 *  that has no costing profile, so it can never be received, shipped or
 *  posted. Details name the line and item. */
export const ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE = "ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE";

/** Machine-readable code: receipt- or shipment-governed billing found no
 *  received/shipped-and-unbilled quantity on any open line. Details carry the
 *  withheld lines. */
export const ORDER_CONVERSION_NOTHING_BILLABLE = "ORDER_CONVERSION_NOTHING_BILLABLE";

/** Display a quantity for an operator message: exact, without trailing zeros. */
export function displayQuantity(units: bigint): string {
  const text = fromQuantityUnits(units);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

export interface KitComponentFulfillmentInput {
  componentItemId: string;
  lotId?: string | null;
  serialId?: string | null;
  /** Bin the component issues from: the kit line's own location or one inside
   *  its warehouse. Omitted, the component issues from the kit line's own
   *  location. */
  stockLocationId?: string | null;
}

export interface SalesFulfillmentLineInput {
  sourceLineId: string;
  quantity: string;
  lotId?: string | null;
  serialId?: string | null;
  /** Bin to issue from: the order line's own location or one inside its
   *  warehouse. Omitted, the line issues from its own location. */
  stockLocationId?: string | null;
  /**
   * A kit order line ships its components: one entry per component with the
   * lot/serial/bin the shipment chose for it. Refused on any other line.
   */
  kitComponents?: KitComponentFulfillmentInput[];
}

export interface CanonicalFulfillmentLine {
  sourceLineId: string;
  quantity: string;
  lotId: string | null;
  serialId: string | null;
  stockLocationId?: string;
  kitComponents?: {
    componentItemId: string;
    lotId: string | null;
    serialId: string | null;
    stockLocationId?: string;
  }[];
}

export type SalesFulfillmentSourceRow = Record<string, unknown> & {
  id: string;
  kind: string;
  status: string;
  party_id: string | null;
  currency: string;
  fx_rate: string;
  document_date: string;
  due_date: string | null;
  subsidiary_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: Record<string, unknown> | null;
  memo: string | null;
  billing_method: string | null;
};

export function canonicalFulfillmentLines(
  lines: SalesFulfillmentLineInput[],
): CanonicalFulfillmentLine[] {
  if (lines.length === 0) throw new ConversionError("Select at least one line to fulfill");
  // One order line may ship from several bins, lots or serials, but each
  // (line, bin, lot, serial) at most once.
  const seen = new Set<string>();
  const canonical = lines.map((line) => {
    const sourceLineId = line.sourceLineId.trim();
    if (!sourceLineId) throw new ConversionError("Fulfillment line id is required");
    const stockLocationId = line.stockLocationId?.trim() || null;
    const lotId = line.lotId?.trim() || null;
    const serialId = line.serialId?.trim() || null;
    const kitComponents = (line.kitComponents ?? []).map((component, componentIndex) => {
      const componentItemId = component.componentItemId.trim();
      if (!componentItemId)
        throw new ConversionError(
          `Kit component ${componentIndex + 1} on fulfillment line ${sourceLineId} is required`,
        );
      return {
        componentItemId,
        lotId: component.lotId?.trim() || null,
        serialId: component.serialId?.trim() || null,
        ...(component.stockLocationId?.trim()
          ? { stockLocationId: component.stockLocationId.trim() }
          : {}),
      };
    });
    const key = [
      sourceLineId,
      stockLocationId ?? "",
      lotId ?? "",
      serialId ?? "",
      JSON.stringify(kitComponents),
    ].join(":");
    if (seen.has(key))
      throw new ConversionError(
        `Fulfillment line ${sourceLineId} was selected more than once for the same bin, lot and serial`,
      );
    seen.add(key);
    let quantity: string;
    try {
      const units = toQuantityUnits(line.quantity);
      if (units <= 0n) throw new Error("non-positive");
      quantity = fromQuantityUnits(units);
    } catch {
      throw new ConversionError(`Fulfillment quantity for line ${sourceLineId} must be positive`);
    }
    // The bin is part of the stored command only when one is named, so a
    // command that names none keeps its established replay identity.
    return {
      sourceLineId,
      quantity,
      lotId,
      serialId,
      ...(stockLocationId ? { stockLocationId } : {}),
      ...(kitComponents.length > 0 ? { kitComponents } : {}),
    };
  });
  const sortKey = (line: CanonicalFulfillmentLine) =>
    [line.sourceLineId, line.stockLocationId ?? "", line.lotId ?? "", line.serialId ?? ""].join(
      ":",
    );
  return canonical.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

export type OrderCycleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
