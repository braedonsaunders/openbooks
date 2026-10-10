import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { auditChange, compareDecimal, decimalValue, refused } from "./master-support.ts";

export interface ItemPolicyInput {
  supplyMethod: "make" | "buy" | "transfer";
  leadTimeDays: number | null;
  safetyStockQty: string;
  minimumQty: string;
  orderMultipleQty: string;
  scrapPctPlanned: string;
}

const policyColumns = sql`id, org_id as "orgId", item_id as "itemId", supply_method as "supplyMethod",
  lead_time_days as "leadTimeDays", safety_stock_qty::text as "safetyStockQty",
  minimum_qty::text as "minimumQty", order_multiple_qty::text as "orderMultipleQty",
  scrap_pct_planned::text as "scrapPctPlanned"`;

/** Item definitions are organization-owned; transactional resources carry entity scope. */
export async function assertManufacturingItemExists(tx: SqlExecutor, orgId: string, itemId: string): Promise<void> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const result = await tx.execute(sql`select id from items where org_id=${orgId} and id=${itemId}`);
  if (!result.rows[0]) throw new ManufacturingNotFoundError();
}

function validate(input: ItemPolicyInput): ItemPolicyInput {
  if (!input || !["make", "buy", "transfer"].includes(input.supplyMethod)) {
    refused("Choose make, buy, or transfer as the supply method.", "invalid_supply_method", "supplyMethod", "Choose make, buy, or transfer.");
  }
  if (input.leadTimeDays !== null && (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0)) {
    refused("Lead time must be a whole number of days greater than or equal to zero, or blank.", "invalid_lead_time", "leadTimeDays", "Enter a non-negative whole number or leave it blank.");
  }
  const safetyStockQty = decimalValue(input.safetyStockQty, "safetyStockQty", "Enter a non-negative exact quantity with no more than four decimal places.");
  const minimumQty = decimalValue(input.minimumQty, "minimumQty", "Enter a non-negative exact quantity with no more than four decimal places.");
  const orderMultipleQty = decimalValue(input.orderMultipleQty, "orderMultipleQty", "Enter a non-negative exact quantity with no more than four decimal places.");
  const scrapPctPlanned = decimalValue(input.scrapPctPlanned, "scrapPctPlanned", "Enter a percentage from 0 up to, but not including, 100.");
  if (compareDecimal(scrapPctPlanned, "100") >= 0) {
    refused("Planned scrap must be at least zero and less than 100 percent.", "invalid_scrap_pct", "scrapPctPlanned", "Enter a percentage from 0 up to, but not including, 100.");
  }
  return { ...input, safetyStockQty, minimumQty, orderMultipleQty, scrapPctPlanned };
}

export async function getItemPolicy(tx: SqlExecutor, orgId: string, itemId: string) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const item = await tx.execute(sql`select 1 from items where org_id=${orgId} and id=${itemId}`);
  if (!item.rows.length) throw new ManufacturingNotFoundError();
  const result = await tx.execute<Record<string, unknown>>(sql`select ${policyColumns} from mfg_item_policies where org_id=${orgId} and item_id=${itemId}`);
  return result.rows[0] ?? null;
}

export async function upsertItemPolicy(
  tx: SqlExecutor, orgId: string, actorId: string, itemId: string, raw: ItemPolicyInput,
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const input = validate(raw);
  const item = await tx.execute(sql`select id from items where org_id=${orgId} and id=${itemId} for update`);
  if (!item.rows.length) throw new ManufacturingNotFoundError();
  if (input.supplyMethod === "transfer") {
    const locations = await tx.execute<{ id: string }>(sql`select id from stock_locations where org_id=${orgId} and is_active order by id for share`);
    if (locations.rows.length < 2) {
      refused("Transfer supply requires at least two active stock locations in this organization.", "transfer_locations_required", "supplyMethod", "Add and activate a second stock location in Setup → Inventory → Stock locations.");
    }
  }
  const existing = await tx.execute<Record<string, unknown>>(sql`select ${policyColumns} from mfg_item_policies where org_id=${orgId} and item_id=${itemId} for update`);
  const before = existing.rows[0] ?? null;
  let after: Record<string, unknown> | undefined;
  if (before) {
    const updated = await tx.execute<Record<string, unknown>>(sql`
      update mfg_item_policies set supply_method=${input.supplyMethod}, lead_time_days=${input.leadTimeDays},
        safety_stock_qty=${input.safetyStockQty}, minimum_qty=${input.minimumQty}, order_multiple_qty=${input.orderMultipleQty},
        scrap_pct_planned=${input.scrapPctPlanned}, updated_by=${actorId}, updated_at=now()
       where org_id=${orgId} and item_id=${itemId} returning ${policyColumns}`);
    after = updated.rows[0];
  } else {
    const inserted = await tx.execute<Record<string, unknown>>(sql`
      insert into mfg_item_policies (org_id, item_id, supply_method, lead_time_days, safety_stock_qty, minimum_qty,
        order_multiple_qty, scrap_pct_planned, created_by, updated_by)
      values (${orgId}, ${itemId}, ${input.supplyMethod}, ${input.leadTimeDays}, ${input.safetyStockQty}, ${input.minimumQty},
        ${input.orderMultipleQty}, ${input.scrapPctPlanned}, ${actorId}, ${actorId})
      returning ${policyColumns}`);
    after = inserted.rows[0];
  }
  if (!after) throw new ManufacturingError("Item planning policy was not saved.", { code: "write_failed", field: "itemId", remedy: "Reload the item and retry the save." });
  await auditChange(tx, { orgId, actorId, table: "mfg_item_policies", rowId: String(after.id), action: before ? "update" : "insert", before, after });
  return after;
}
