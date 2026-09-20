import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, neg } from "../money/money.ts";
import {
  loadCountHeader,
  parseCountStatus,
  type CountHeader,
  type CountLine,
  type StockCountStatus,
} from "./stock-counts.ts";

/**
 * Read surface for the cycle-count module: the counts list and one count's
 * detail, for the API and the counts page.
 *
 * Separated from the lifecycle so neither file carries the other's weight
 * (engine/src/inventory/inventory-boundary.test.ts bounds every operation
 * module). Readers only ever read: nothing here transitions a count, snapshots
 * a quantity, or posts a variance — those live in stock-counts.ts, which this
 * module imports and never imports back.
 */

export interface StockCountSummary {
  id: string;
  status: StockCountStatus;
  locationId: string;
  locationName: string | null;
  countedOn: string;
  memo: string | null;
  lineCount: number;
  uncountedCount: number;
  variance: string;
}

export async function listStockCounts(orgId: string): Promise<StockCountSummary[]> {
  const r = (await db.execute<{
    id: string;
    status: string;
    location_id: string;
    location_name: string | null;
    counted_on: string;
    memo: string | null;
    line_count: string;
    uncounted_count: string;
    variance: string | null;
  }>(sql`
    select c.id, c.status, c.location_id,
           (select name from locations where org_id = ${orgId} and id = c.location_id) as location_name,
           c.counted_on::text, c.memo,
           (select count(*)::text from stock_count_lines l
             where l.org_id = ${orgId} and l.stock_count_id = c.id) as line_count,
           (select count(*)::text from stock_count_lines l
             where l.org_id = ${orgId} and l.stock_count_id = c.id and l.counted_quantity is null) as uncounted_count,
           (select sum(l.counted_quantity - l.expected_quantity)::text from stock_count_lines l
             where l.org_id = ${orgId} and l.stock_count_id = c.id and l.counted_quantity is not null) as variance
      from stock_counts c
     where c.org_id = ${orgId}
     order by c.counted_on desc, c.created_at desc, c.id
     limit 500`));
  return r.rows.map((row) => ({
    id: row.id,
    status: parseCountStatus(row.status),
    locationId: row.location_id,
    locationName: row.location_name,
    countedOn: row.counted_on,
    memo: row.memo,
    lineCount: Number(row.line_count),
    uncountedCount: Number(row.uncounted_count),
    variance: row.variance ?? "0",
  }));
}

export interface StockCountLineDetail extends CountLine {
  itemCode: string | null;
  itemName: string | null;
  stockLocationCode: string | null;
  lotNumber: string | null;
  variance: string | null;
}

export interface StockCountDetail {
  header: CountHeader & { locationName: string | null; subsidiaryName: string | null };
  lines: StockCountLineDetail[];
}

export async function getStockCountDetail(orgId: string, countId: string): Promise<StockCountDetail> {
  const header = await loadCountHeader(db, orgId, countId, false);
  const names = (await db.execute<{ location_name: string | null; subsidiary_name: string | null }>(sql`
    select (select name from locations where org_id = ${orgId} and id = ${header.locationId}) as location_name,
           (select name from subsidiaries where org_id = ${orgId} and id = ${header.subsidiaryId}) as subsidiary_name`)).rows[0];
  const r = (await db.execute<{
    id: string;
    item_id: string;
    stock_location_id: string;
    lot_id: string | null;
    expected_quantity: string;
    counted_quantity: string | null;
    adjustment_movement_id: string | null;
    item_code: string | null;
    item_name: string | null;
    stock_location_code: string | null;
    lot_number: string | null;
  }>(sql`
    select l.id, l.item_id, l.stock_location_id, l.lot_id,
           l.expected_quantity::text, l.counted_quantity::text, l.adjustment_movement_id,
           (select code from items where org_id = ${orgId} and id = l.item_id) as item_code,
           (select name from items where org_id = ${orgId} and id = l.item_id) as item_name,
           (select code from stock_locations where org_id = ${orgId} and id = l.stock_location_id) as stock_location_code,
           (select lot_number from lots where org_id = ${orgId} and id = l.lot_id) as lot_number
      from stock_count_lines l
     where l.org_id = ${orgId} and l.stock_count_id = ${header.id}
     order by item_code nulls last, stock_location_code nulls last, l.id`));
  return {
    header: {
      ...header,
      locationName: names?.location_name ?? null,
      subsidiaryName: names?.subsidiary_name ?? null,
    },
    lines: r.rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      stockLocationId: row.stock_location_id,
      lotId: row.lot_id,
      expectedQuantity: row.expected_quantity,
      countedQuantity: row.counted_quantity,
      adjustmentMovementId: row.adjustment_movement_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      stockLocationCode: row.stock_location_code,
      lotNumber: row.lot_number,
      variance: row.counted_quantity === null ? null : add(row.counted_quantity, neg(row.expected_quantity)),
    })),
  };
}

