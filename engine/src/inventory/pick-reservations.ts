import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { openQuantitySql } from "../records/order-line-remainders.ts";

/**
 * One reservation a pick list holds against a sales-order line and a bin.
 *
 * A pick list is active while it is not voided and its stage is still open;
 * completing its shipment ends the reservation. `reserved` is the part of
 * the pick line's quantity still backed by the order line's open quantity:
 * the line's active pick lines are ranked (released first, then oldest) and
 * each takes what the open quantity has left after the ones before it. So a
 * reservation never counts beyond the line's open quantity — an order
 * fulfilled or cancelled through another path shrinks it rather than
 * leaving a phantom hold on the bin.
 */
export interface PickReservation {
  pickListId: string;
  pickListNumber: string;
  /** documents.status of the pick list: draft, pending_approval or approved. */
  pickListStatus: string;
  pickLineId: string;
  salesOrderLineId: string;
  itemId: string;
  binId: string;
  lotId: string | null;
  serialId: string | null;
  /** Exact numeric(28,8) strings. */
  quantity: string;
  reserved: string;
}

export interface PickReservationFilter {
  salesOrderLineIds?: readonly string[];
  itemId?: string;
  binId?: string;
  /** Only pick lists released to approved (the ones holding bin stock). */
  releasedOnly?: boolean;
  excludePickListId?: string;
}

interface ReservationRow extends Record<string, unknown> {
  pick_list_id: string;
  pick_list_number: string;
  pick_list_status: string;
  pick_line_id: string;
  sales_order_line_id: string;
  item_id: string;
  bin_id: string;
  lot_id: string | null;
  serial_id: string | null;
  quantity: string;
  reserved: string;
}

/**
 * The ranked-reservation common table expressions, for callers that
 * aggregate reservations in SQL so quantities stay exact numerics. Embed as
 * `with ${pickReservationsCte(orgId)}, …` and read the `pick_reservations`
 * relation: one row per active pick line with its `reserved` quantity.
 *
 * Every active pick line of a sales-order line is ranked before any filter
 * narrows the result, so the reserved quantity of one row never depends on
 * which rows the caller asks for.
 */
export function pickReservationsCte(orgId: string): SQL {
  return sql`
    pick_active as (
      select pick.id as pick_list_id, pick.document_number as pick_list_number,
             pick.status as pick_list_status, pick.created_at,
             line.id as pick_line_id, line.line_number, fl.sales_order_line_id,
             line.item_id, line.stock_location_id as bin_id, fl.lot_id, fl.serial_id,
             line.quantity
        from fulfillment_lines fl
        join fulfillment_documents fd on fd.document_id = fl.document_id and fd.org_id = fl.org_id
        join documents pick on pick.id = fl.document_id and pick.org_id = fl.org_id
        join document_lines line on line.id = fl.line_id and line.org_id = fl.org_id
       where fl.org_id = ${orgId}
         and pick.kind = 'pick_list'
         and pick.status in ('draft', 'pending_approval', 'approved')
         and fd.stage = 'open'
    ),
    pick_scaled as (
      select a.*,
             ${openQuantitySql("so_line")} as base_open,
             bom.quantity_per as kit_quantity_per
        from pick_active a
        join document_lines so_line
          on so_line.id = a.sales_order_line_id and so_line.org_id = ${orgId}
        join documents so_doc
          on so_doc.id = so_line.document_id and so_doc.org_id = ${orgId}
        left join bom_components bom
          on bom.org_id = ${orgId}
         and bom.assembly_item_id = so_line.item_id
         and bom.component_item_id = a.item_id
         and bom.operation_seq is null
         and bom.is_byproduct = false
         and (bom.effective_from is null or bom.effective_from <= so_doc.document_date)
         and (bom.effective_to is null or so_doc.document_date < bom.effective_to)
    ),
    pick_ranked as (
      select a.*,
             case when a.kit_quantity_per is null
               then a.base_open
               else a.base_open * a.kit_quantity_per
             end as line_open,
             coalesce(sum(a.quantity) over (
               partition by a.sales_order_line_id, a.item_id
               order by (a.pick_list_status = 'approved') desc, a.created_at, a.pick_list_id, a.line_number
               rows between unbounded preceding and 1 preceding), 0) as ahead
        from pick_scaled a
    ),
    pick_reservations as (
      select pick_list_id, pick_list_number, pick_list_status, pick_line_id, sales_order_line_id,
             item_id, bin_id, lot_id, serial_id, quantity,
             greatest(0, least(quantity, line_open - ahead)) as reserved
        from pick_ranked
    )`;
}

/** Active pick-list reservations, optionally narrowed. */
export async function activePickReservations(
  runner: SqlExecutor,
  orgId: string,
  filter: PickReservationFilter = {},
): Promise<PickReservation[]> {
  const rows = (await runner.execute<ReservationRow>(sql`
    with ${pickReservationsCte(orgId)}
    select pick_list_id, pick_list_number, pick_list_status, pick_line_id, sales_order_line_id,
           item_id, bin_id, lot_id, serial_id, quantity::text as quantity, reserved::text as reserved
      from pick_reservations
     where true
       ${filter.salesOrderLineIds ? sql`and sales_order_line_id = any(${uuidArray([...filter.salesOrderLineIds])}::uuid[])` : sql``}
       ${filter.itemId ? sql`and item_id = ${filter.itemId}` : sql``}
       ${filter.binId ? sql`and bin_id = ${filter.binId}` : sql``}
       ${filter.releasedOnly ? sql`and pick_list_status = 'approved'` : sql``}
       ${filter.excludePickListId ? sql`and pick_list_id <> ${filter.excludePickListId}` : sql``}
     order by pick_list_number, pick_line_id
  `)).rows;
  return rows.map((row) => ({
    pickListId: row.pick_list_id,
    pickListNumber: row.pick_list_number,
    pickListStatus: row.pick_list_status,
    pickLineId: row.pick_line_id,
    salesOrderLineId: row.sales_order_line_id,
    itemId: row.item_id,
    binId: row.bin_id,
    lotId: row.lot_id,
    serialId: row.serial_id,
    quantity: row.quantity,
    reserved: row.reserved,
  }));
}
