import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * The one open-quantity rule for order lines. Every line's ordered quantity
 * is accounted for by three terms — shipped, cancelled, still open:
 *
 *   quantity = quantity_fulfilled + quantity_cancelled + open
 *
 * so the open quantity is `quantity − quantity_fulfilled − quantity_cancelled`.
 * A cancelled remainder is no longer owed and is never shipped or billed, so
 * the quantity a line can still bill up to is `quantity − quantity_cancelled`.
 * Every reader of an order remainder — fulfilment, billing, the order
 * drawer, the backorder position, availability, stock on order for
 * replenishment — builds from these two fragments, so the rule cannot drift
 * between them.
 *
 * @param lineAlias the SQL alias of the `document_lines` row (a static
 * identifier from the calling query, never user input).
 */
export function openQuantitySql(lineAlias: string): SQL {
  const line = sql.raw(lineAlias);
  return sql`(${line}.quantity - ${line}.quantity_fulfilled - ${line}.quantity_cancelled)`;
}

/** The ordered quantity still owed after cancellations: the ceiling for
 *  fulfilment plus open quantity, and for billing. */
export function orderedNetOfCancelledSql(lineAlias: string): SQL {
  const line = sql.raw(lineAlias);
  return sql`(${line}.quantity - ${line}.quantity_cancelled)`;
}

/** One order line's quantity split, as every remainder reader sees it. */
interface OrderLineRemainder {
  documentId: string;
  documentNumber: string;
  documentDate: string;
  lineId: string;
  lineNumber: number;
  itemId: string;
  stockLocationId: string | null;
  subsidiaryId: string | null;
  /** The unit the line's quantities are raised in; null is the item's base unit. */
  unit: string | null;
  /** Exact numeric(28,8) quantity strings, straight from the database. */
  quantity: string;
  fulfilled: string;
  cancelled: string;
  open: string;
}

export interface SalesOrderLineRemainder extends OrderLineRemainder {
  customerId: string | null;
}

/** On a purchase order, `fulfilled` is the quantity received. */
export interface PurchaseOrderLineRemainder extends OrderLineRemainder {
  vendorId: string | null;
}

export interface OrderLineRemainderFilter {
  documentId?: string;
  lineId?: string;
  itemId?: string;
  /** Only lines with open quantity above zero (the backorder position, or
   *  stock still on order). */
  openOnly?: boolean;
}

interface RemainderRow extends Record<string, unknown> {
  document_id: string;
  document_number: string;
  document_date: string;
  line_id: string;
  line_number: number;
  item_id: string;
  stock_location_id: string | null;
  subsidiary_id: string | null;
  party_id: string | null;
  unit: string | null;
  quantity: string;
  fulfilled: string;
  cancelled: string;
  open: string;
}

/**
 * Remainders of one kind of approved order's stock lines. A stock line is one
 * whose item carries an inventory costing profile — the lines fulfilment
 * ships and receiving receives. Ordered by order date, then document number,
 * then line, which is the order backorders are served in.
 */
async function orderLineRemainders(
  runner: SqlExecutor,
  orgId: string,
  kind: "sales_order" | "purchase_order",
  filter: OrderLineRemainderFilter,
): Promise<Array<OrderLineRemainder & { partyId: string | null }>> {
  const rows = (await runner.execute<RemainderRow>(sql`
    select d.id as document_id, d.document_number, d.document_date::text as document_date,
           dl.id as line_id, dl.line_number, dl.item_id, dl.stock_location_id,
           d.subsidiary_id, d.party_id, dl.unit,
           dl.quantity::text as quantity,
           dl.quantity_fulfilled::text as fulfilled,
           dl.quantity_cancelled::text as cancelled,
           ${openQuantitySql("dl")}::text as open
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      join item_inventory_profiles profile
        on profile.item_id = dl.item_id and profile.org_id = dl.org_id
     where dl.org_id = ${orgId}
       and d.kind = ${kind}
       and d.status = 'approved'
       ${filter.documentId ? sql`and d.id = ${filter.documentId}` : sql``}
       ${filter.lineId ? sql`and dl.id = ${filter.lineId}` : sql``}
       ${filter.itemId ? sql`and dl.item_id = ${filter.itemId}` : sql``}
       ${filter.openOnly ? sql`and ${openQuantitySql("dl")} > 0` : sql``}
     order by d.document_date, d.document_number, dl.line_number
  `)).rows;
  return rows.map((row) => ({
    documentId: row.document_id,
    documentNumber: row.document_number,
    documentDate: row.document_date,
    lineId: row.line_id,
    lineNumber: Number(row.line_number),
    itemId: row.item_id,
    stockLocationId: row.stock_location_id,
    subsidiaryId: row.subsidiary_id,
    partyId: row.party_id,
    unit: row.unit,
    quantity: row.quantity,
    fulfilled: row.fulfilled,
    cancelled: row.cancelled,
    open: row.open,
  }));
}

/**
 * Remainders of approved sales orders' stock lines. Quantities are returned
 * as exact decimal strings; callers compare them with the bigint quantity
 * helpers, never as JavaScript numbers.
 */
export async function salesOrderLineRemainders(
  runner: SqlExecutor,
  orgId: string,
  filter: OrderLineRemainderFilter = {},
): Promise<SalesOrderLineRemainder[]> {
  const rows = await orderLineRemainders(runner, orgId, "sales_order", filter);
  return rows.map(({ partyId, ...row }) => ({ ...row, customerId: partyId }));
}

/**
 * Remainders of approved purchase orders' stock lines: the quantity still on
 * order is the same open-quantity rule, with receipts advancing `fulfilled`.
 */
export async function purchaseOrderLineRemainders(
  runner: SqlExecutor,
  orgId: string,
  filter: OrderLineRemainderFilter = {},
): Promise<PurchaseOrderLineRemainder[]> {
  const rows = await orderLineRemainders(runner, orgId, "purchase_order", filter);
  return rows.map(({ partyId, ...row }) => ({ ...row, vendorId: partyId }));
}
