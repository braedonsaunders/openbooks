import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";

export interface PrefillBillLine {
  lineId: string;
  itemId: string | null;
  accountId: string;
  amount: string | null;
  quantity: string;
  unitPrice: string | null;
  description: string | null;
  taxCodeId: string | null;
  taxGroupId: string | null;
  stockLocationId: string | null;
  /** Posted receipt movement with unreturned remainder, when the bill line received directly. */
  receiptMovementId: string | null;
  received: string | null;
  returned: string;
}

/**
 * Returnable (unreturned) receipt quantities per bill line for the vendor
 * credit prefill: a stocked line split across receipts prefills one line
 * per receipt movement at its still-unreturned remainder, priced at the
 * original unit price; fully-returned receipts drop out so the proposal can
 * never over-return on arrival. Lines the bill never received directly
 * (goods received against the purchase order, or a still-draft bill)
 * prefill with no return evidence — the operator picks the receipt or
 * records the line as an allowance before saving. Non-stocked lines prefill
 * in full.
 */
export async function returnableBillLines(
  runner: SqlExecutor,
  orgId: string,
  billId: string,
): Promise<PrefillBillLine[]> {
  const rows = (await runner.execute<PrefillBillLine>(sql`
    with received as (
      select m.document_line_id as line_id, m.id as movement_id,
             m.quantity as received_qty
        from inventory_movements m
       where m.org_id = ${orgId} and m.document_line_id in (
         select id from document_lines where org_id = ${orgId} and document_id = ${billId} and item_id is not null
       )
         and m.kind = 'receipt' and m.status = 'posted'
    ),
    returned as (
      -- Posted returns only: a return that was itself reversed is returnable
      -- again at posting time, so counting it here can only under-offer —
      -- never over-offer — on arrival.
      select (l.custom->'inventoryReturn'->>'sourceReceiptMovementId') as receipt_id,
             coalesce(sum(-m.quantity), 0) as qty
        from document_lines l
        join documents d on d.id = l.document_id and d.org_id = l.org_id
        left join inventory_movements m on m.document_line_id = l.id and m.org_id = l.org_id
         and m.kind = 'return' and m.status = 'posted'
       where l.org_id = ${orgId}
         and l.custom->'inventoryReturn'->>'sourceReceiptMovementId' in (select movement_id::text from received)
         and d.status = 'posted'
       group by 1
    )
    select l.id as "lineId", l.item_id as "itemId", l.account_id as "accountId",
           case when s.movement_id is null or l.unit_price is null then l.amount
                else (l.unit_price * greatest(s.received_qty - coalesce(r.qty, 0), 0)) end::text as amount,
           case when s.movement_id is null then l.quantity
                else greatest(s.received_qty - coalesce(r.qty, 0), 0) end::text as quantity,
           l.unit_price::text as "unitPrice", l.description,
           l.tax_code_id as "taxCodeId", l.tax_group_id as "taxGroupId",
           l.stock_location_id as "stockLocationId",
           s.movement_id as "receiptMovementId", s.received_qty::text as received,
           coalesce(r.qty, 0)::text as returned
      from document_lines l
      left join received s on s.line_id = l.id
      left join returned r on r.receipt_id = s.movement_id::text
     where l.org_id = ${orgId} and l.document_id = ${billId}
       and (s.movement_id is null or s.received_qty - coalesce(r.qty, 0) > 0)
     order by l.line_number`)).rows;
  return rows;
}
