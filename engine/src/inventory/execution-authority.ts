import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { InventoryError } from "./contracts.ts";

/** Scan evidence must be authored in the operation's transaction, never borrowed from prior work. */
export async function requireExecutionConfirmation(
  tx: SqlExecutor,
  orgId: string,
  input: {
    stage: "putaway" | "count";
    taskId?: string;
    lineId?: string;
    itemId?: string;
    fromBinId?: string;
    toBinId?: string;
    quantity: string;
    observation?: "first" | "second";
  },
) {
  if (!(await lockAndCheckOrgFeature(tx, orgId, "barcodeScanning"))) return;
  if (!input.taskId)
    throw new InventoryError(
      "Scan the suggested bin, item and quantity through warehouse execution before posting this observation",
    );
  const evidence = (
    await tx.execute(sql`select task.id from warehouse_execution_tasks task
    join warehouse_scan_events event on event.org_id=task.org_id and event.task_id=task.id and event.outcome='confirmed'
    where task.org_id=${orgId} and task.id=${input.taskId} and task.stage=${input.stage} and task.status='open'
      and event.xmin=(txid_current()%4294967296)::text::xid and task.quantity=${input.quantity}::numeric
      ${input.lineId ? sql`and task.count_line_id=${input.lineId}` : sql``}
      ${input.itemId ? sql`and task.item_id=${input.itemId}` : sql``}
      ${input.fromBinId ? sql`and task.from_stock_location_id=${input.fromBinId}` : sql``}
      ${input.toBinId ? sql`and task.to_stock_location_id=${input.toBinId}` : sql``}
      ${input.observation ? sql`and task.basis->>'observation'=${input.observation}` : sql``}
    limit 1`)
  ).rows[0];
  if (!evidence)
    throw new InventoryError(
      "This scan does not authorize the current warehouse operation; refresh its suggestion and scan again",
    );
}
