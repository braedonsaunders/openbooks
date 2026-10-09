import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { InventoryError } from "./contracts.ts";
/** Posted receipt lines remain individually identifiable even when a purchase order spans bins or lots. */
export async function purchaseReceiptQueue(
  tx: SqlExecutor,
  orgId: string,
  scope: ReadonlySet<string> | null,
) {
  if (!(await orgFeatureEnabled(orgId, "warehousing", tx)))
    throw new InventoryError("Turn on Warehousing before receiving stock");
  return (
    await tx.execute<{
      lineId: string;
      number: string;
      itemLabel: string;
      binCode: string;
      quantity: string;
      confirmed: boolean;
    }>(sql`
    select line.id as "lineId",receipt.document_number as number,coalesce(nullif(item.code,''),item.name) as "itemLabel",
      bin.code as "binCode",line.quantity::text as quantity,false as confirmed
    from document_lines line join documents receipt on receipt.org_id=line.org_id and receipt.id=line.document_id
    join items item on item.org_id=line.org_id and item.id=line.item_id
    join stock_locations bin on bin.org_id=line.org_id and bin.id=line.stock_location_id
    where line.org_id=${orgId} and receipt.kind='purchase_receipt' and receipt.status='approved'
      ${scope === null ? sql`` : sql`and receipt.subsidiary_id=any(${uuidArray([...scope])}::uuid[])`}
      and exists(select 1 from inventory_movements movement where movement.org_id=line.org_id and movement.document_line_id=line.id
        and movement.kind='receipt' and movement.status='posted')
      and not exists(select 1 from warehouse_execution_tasks task where task.org_id=line.org_id and task.document_line_id=line.id
        and task.stage='receive' and task.status='done')
    order by receipt.document_date desc,receipt.id desc,line.line_number limit 500`)
  ).rows;
}
