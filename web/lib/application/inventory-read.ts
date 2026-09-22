import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoneyValue } from "../cash/core";
import { isFeatureEnabled } from "../features";
import { clamp } from "../list-params";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError } from "./errors";

/** On-hand stock from posted movements — same query as `inventory_levels`. */
export async function listApplicationInventoryLevels(
  context: ApplicationContext,
  input: { itemId?: string; stockLocationId?: string; limit?: number },
) {
  assertApplicationPermission(context, "items.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "inventory"))) {
    throw new ApplicationError(
      "not_found",
      "inventory is off; enable it from GET /api/v1/settings/features",
      404,
    );
  }
  const limit = clamp(input.limit ?? 50, 1, 200);
  const scope = subsidiaryVisibleFilter(sql`m.subsidiary_id`, context.authz.allowedSubsidiaryIds);
  let where = sql`m.org_id = ${context.authz.user.orgId} and m.status = 'posted' ${scope}`;
  if (input.itemId) where = sql`${where} and m.item_id = ${input.itemId}`;
  if (input.stockLocationId) where = sql`${where} and m.stock_location_id = ${input.stockLocationId}`;
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select i.id as item_id, i.code as item_code, i.name as item_name,
           sl.id as stock_location_id, sl.code as stock_location_code,
           coalesce(sum(m.quantity), 0)::text as quantity,
           coalesce(sum(m.total_value), 0)::text as value
      from inventory_movements m
      join items i on i.id = m.item_id and i.org_id = m.org_id
      left join stock_locations sl on sl.id = m.stock_location_id and sl.org_id = m.org_id
     where ${where}
     group by i.id, i.code, i.name, sl.id, sl.code
    having coalesce(sum(m.quantity), 0) <> 0
     order by i.name, sl.code
     limit ${limit}`)).rows;
  const totals = (await db.execute<{ lines: number; quantity: string; value: string }>(sql`
    select count(*)::int as lines,
           coalesce(sum(sub.quantity), 0)::text as quantity,
           coalesce(sum(sub.value), 0)::text as value
      from (
        select sum(m.quantity) as quantity, sum(m.total_value) as value
          from inventory_movements m
         where ${where}
         group by m.item_id, m.stock_location_id
        having coalesce(sum(m.quantity), 0) <> 0
      ) sub`)).rows[0];
  return {
    total: Number(totals?.lines ?? 0),
    sumQuantity: totals?.quantity ?? "0",
    sumValue: normalizeMoneyValue(String(totals?.value ?? "0")),
    levels: rows.map((row) => ({
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      stockLocationId: row.stock_location_id,
      stockLocationCode: row.stock_location_code,
      quantity: String(row.quantity ?? "0"),
      value: normalizeMoneyValue(String(row.value ?? "0")),
    })),
  };
}
