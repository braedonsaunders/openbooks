import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { subsidiaryVisibleFilter } from "./subsidiaries";

export type ReceivablePurchaseOrderRow = Record<string, unknown> & {
  id: string;
  number: string | null;
  vendor: string | null;
  openLines: number;
};

/** Approved stock orders that the goods-receipt flow can receive into inventory. */
export async function listReceivablePurchaseOrders(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  return db.execute<ReceivablePurchaseOrderRow>(sql`
    select d.id, d.document_number as "number", p.display_name as "vendor",
           count(*)::int as "openLines"
      from documents d
      join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
                  and i.kind in ('inventory', 'assembly')
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.kind = 'purchase_order' and d.status = 'approved'
       and dl.quantity > dl.quantity_fulfilled + dl.quantity_cancelled
       and not exists (
         select 1 from drop_ship_orders ds
          where ds.org_id = d.org_id and ds.purchase_order_id = d.id
       )
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     group by d.id, d.document_number, d.document_date, p.display_name
     order by d.document_date desc, d.document_number, d.id
     limit 100
  `);
}
