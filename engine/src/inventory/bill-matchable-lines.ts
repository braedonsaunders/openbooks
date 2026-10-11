import { sql } from "drizzle-orm";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { normalizeInventoryUnit } from "./costing.ts";

/**
 * The one predicate for a purchase-order line a vendor-bill line can match.
 *
 * A bill line hand-coded for receipt-tracked stock may only clear
 * received-not-billed against its purchase order when the order line is all
 * of: on an approved purchase order of the same organization, vendor, and
 * legal entity; for the bill line's own item (unit spellings folded, so
 * "LB" and "lb" are the same line); and holding received-not-yet-billed
 * cover — received quantity less billed quantity — above zero.
 * Ordered-but-unreceived quantity is never matchable: the goods arrive
 * first, then the bill matches. The posting guard and the Match dialog both
 * read this predicate, so the guard refuses exactly the lines the dialog
 * can offer — never an unreceived remainder, never another vendor's cover.
 */
export interface MatchableBillLineScope {
  itemId: string;
  unit: string | null;
  /** The bill's vendor; null matches only a vendor-less order. */
  partyId: string | null;
  /** The bill's legal entity; null matches only an entity-less order. */
  subsidiaryId: string | null;
}

export interface MatchablePurchaseOrderLine {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  purchaseOrderLineId: string;
  purchaseOrderLineNumber: number;
  itemCode: string | null;
  itemName: string;
  unit: string | null;
  unitPrice: string;
  orderedQuantity: string;
  fulfilledQuantity: string;
  billedQuantity: string;
  cancelledQuantity: string;
  /** Received-and-unbilled cover under conversion's own ceilings. */
  billableQuantity: string;
}

export function billableRemainderUnits(input: {
  orderedQuantity: string;
  billedQuantity: string;
  cancelledQuantity: string;
  fulfilledQuantity: string;
  requiresReceipt: boolean;
}): bigint {
  // The same ceiling order conversion bills from: stock lines bill only
  // received-and-unbilled cover, other lines the ordered remainder.
  const remaining =
    toQuantityUnits(input.orderedQuantity) -
    toQuantityUnits(input.cancelledQuantity) -
    toQuantityUnits(input.billedQuantity);
  if (remaining <= 0n) return 0n;
  if (!input.requiresReceipt) return remaining;
  const cover = toQuantityUnits(input.fulfilledQuantity) - toQuantityUnits(input.billedQuantity);
  if (cover <= 0n) return 0n;
  return cover < remaining ? cover : remaining;
}

/**
 * Every purchase-order line the scoped bill line can match, in dialog
 * order. Storage filters the vendor, entity, approval, item, and cover;
 * unit spellings fold in this process so a database collation can never
 * disagree with the match's own comparison.
 */
export async function matchablePurchaseOrderLines(
  runner: SqlExecutor,
  orgId: string,
  scope: MatchableBillLineScope,
): Promise<MatchablePurchaseOrderLine[]> {
  const rows = (await runner.execute<{
    purchase_order_id: string;
    purchase_order_number: string;
    purchase_order_line_id: string;
    purchase_order_line_number: number;
    item_code: string | null;
    item_name: string;
    unit: string | null;
    unit_price: string;
    ordered_quantity: string;
    fulfilled_quantity: string;
    billed_quantity: string;
    cancelled_quantity: string;
  }>(sql`
    select d.id as purchase_order_id, d.document_number as purchase_order_number,
           dl.id as purchase_order_line_id, dl.line_number as purchase_order_line_number,
           i.code as item_code, i.name as item_name,
           dl.unit, dl.unit_price::text as unit_price,
           dl.quantity::text as ordered_quantity, dl.quantity_fulfilled::text as fulfilled_quantity,
           dl.quantity_billed::text as billed_quantity, dl.quantity_cancelled::text as cancelled_quantity
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
     where dl.org_id = ${orgId}
       and d.kind = 'purchase_order'
       and d.status = 'approved'
       and dl.item_id = ${scope.itemId}
       and (d.party_id is not distinct from ${scope.partyId})
       and (d.subsidiary_id is not distinct from ${scope.subsidiaryId})
       and (dl.quantity_fulfilled - dl.quantity_billed) > 0
     order by d.document_number, dl.line_number`)).rows;
  const wanted = normalizeInventoryUnit(scope.unit);
  const result: MatchablePurchaseOrderLine[] = [];
  for (const row of rows) {
    if (normalizeInventoryUnit(row.unit) !== wanted) continue;
    const billable = billableRemainderUnits({
      orderedQuantity: row.ordered_quantity,
      billedQuantity: row.billed_quantity,
      cancelledQuantity: row.cancelled_quantity,
      fulfilledQuantity: row.fulfilled_quantity,
      requiresReceipt: true,
    });
    if (billable <= 0n) continue;
    result.push({
      purchaseOrderId: row.purchase_order_id,
      purchaseOrderNumber: row.purchase_order_number,
      purchaseOrderLineId: row.purchase_order_line_id,
      purchaseOrderLineNumber: row.purchase_order_line_number,
      itemCode: row.item_code,
      itemName: row.item_name,
      unit: row.unit,
      unitPrice: row.unit_price,
      orderedQuantity: row.ordered_quantity,
      fulfilledQuantity: row.fulfilled_quantity,
      billedQuantity: row.billed_quantity,
      cancelledQuantity: row.cancelled_quantity,
      billableQuantity: fromQuantityUnits(billable),
    });
  }
  return result;
}
