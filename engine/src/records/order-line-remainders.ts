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
 * Every reader of a sales-order remainder — fulfilment, billing, the order
 * drawer, the backorder position, availability — builds from these two
 * fragments, so the rule cannot drift between them.
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

export interface SalesOrderLineRemainder {
  documentId: string;
  documentNumber: string;
  lineId: string;
  lineNumber: number;
  itemId: string;
  stockLocationId: string | null;
  subsidiaryId: string | null;
  customerId: string | null;
  /** Exact numeric(28,8) quantity strings, straight from the database. */
  quantity: string;
  fulfilled: string;
  cancelled: string;
  open: string;
}

export interface SalesOrderLineRemainderFilter {
  documentId?: string;
  lineId?: string;
  /** Only lines with open quantity above zero (the backorder position). */
  openOnly?: boolean;
}

interface RemainderRow extends Record<string, unknown> {
  document_id: string;
  document_number: string;
  line_id: string;
  line_number: number;
  item_id: string;
  stock_location_id: string | null;
  subsidiary_id: string | null;
  customer_id: string | null;
  quantity: string;
  fulfilled: string;
  cancelled: string;
  open: string;
}

/**
 * Remainders of approved sales orders' stock lines. A stock line is one whose
 * item carries an inventory costing profile — the lines fulfilment ships.
 * Quantities are returned as exact decimal strings; callers compare them with
 * the bigint quantity helpers, never as JavaScript numbers.
 */
export async function salesOrderLineRemainders(
  runner: SqlExecutor,
  orgId: string,
  filter: SalesOrderLineRemainderFilter = {},
): Promise<SalesOrderLineRemainder[]> {
  const rows = (await runner.execute<RemainderRow>(sql`
    select d.id as document_id, d.document_number, dl.id as line_id, dl.line_number,
           dl.item_id, dl.stock_location_id, d.subsidiary_id, d.party_id as customer_id,
           dl.quantity::text as quantity,
           dl.quantity_fulfilled::text as fulfilled,
           dl.quantity_cancelled::text as cancelled,
           ${openQuantitySql("dl")}::text as open
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      join item_inventory_profiles profile
        on profile.item_id = dl.item_id and profile.org_id = dl.org_id
     where dl.org_id = ${orgId}
       and d.kind = 'sales_order'
       and d.status = 'approved'
       ${filter.documentId ? sql`and d.id = ${filter.documentId}` : sql``}
       ${filter.lineId ? sql`and dl.id = ${filter.lineId}` : sql``}
       ${filter.openOnly ? sql`and ${openQuantitySql("dl")} > 0` : sql``}
     order by d.document_date, d.document_number, dl.line_number
  `)).rows;
  return rows.map((row) => ({
    documentId: row.document_id,
    documentNumber: row.document_number,
    lineId: row.line_id,
    lineNumber: Number(row.line_number),
    itemId: row.item_id,
    stockLocationId: row.stock_location_id,
    subsidiaryId: row.subsidiary_id,
    customerId: row.customer_id,
    quantity: row.quantity,
    fulfilled: row.fulfilled,
    cancelled: row.cancelled,
    open: row.open,
  }));
}
