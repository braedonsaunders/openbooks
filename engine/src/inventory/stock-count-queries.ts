import { requiresSecondCount } from "./count-policy.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { add, neg } from "../money/money.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { InventoryError, InventoryNotFoundError } from "./contracts.ts";
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
  /**
   * Lines with a counted quantity that differs from the snapshot. A
   * cross-item quantity sum is never shown: one item −5 kg and another +5
   * each would sum to 0 while both lines still disagree with the shelf.
   */
  discrepantLineCount: number;
}

export interface StockCountListQuery {
  /**
   * Legal entities the caller may see. Null/undefined reads org-wide (full
   * access); an empty set matches nothing — an empty grant fails closed.
   */
  subsidiaryIds?: readonly string[] | null;
  /** Page size, 1..500 (default 500). */
  limit?: number;
  /** One-based page for URL-driven list workspaces. Omit to use cursor paging. */
  page?: number;
  /** Literal text search across date, location, status, and memo. */
  search?: string;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string | null;
}

export interface StockCountListPage {
  counts: StockCountSummary[];
  totalCount: number;
  /** Opaque cursor for the next page, or null past the end. */
  nextCursor: string | null;
}

const LIST_ORDER = sql`c.counted_on desc, c.created_at desc, c.id`;

/** Resolve the owning entity used by the stock-count API boundary. */
export async function stockCountSubsidiary(orgId: string, countId: string): Promise<string | null> {
  const rows = await db.execute<{ subsidiary_id: string }>(
    sql`select subsidiary_id from stock_counts where id = ${countId} and org_id = ${orgId}`,
    "objects",
  );
  return rows[0]?.subsidiary_id ?? null;
}

function subsidiaryScope(
  subsidiaryIds: readonly string[] | null | undefined,
): ReturnType<typeof sql> {
  if (subsidiaryIds == null) return sql``;
  return sql`and c.subsidiary_id = any(${uuidArray(subsidiaryIds)}::uuid[])`;
}

interface ListCursor {
  countedOn: string;
  createdAt: string;
  id: string;
}

function parseListCursor(cursor: string): ListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InventoryError(
      "stock count page cursor is invalid — reload the list from the first page",
    );
  }
  const p = parsed as Partial<ListCursor>;
  if (
    typeof p?.countedOn !== "string" ||
    typeof p?.createdAt !== "string" ||
    typeof p?.id !== "string"
  ) {
    throw new InventoryError(
      "stock count page cursor is invalid — reload the list from the first page",
    );
  }
  return { countedOn: p.countedOn, createdAt: p.createdAt, id: p.id };
}

export async function listStockCounts(
  orgId: string,
  query: StockCountListQuery = {},
): Promise<StockCountListPage> {
  const wanted = Math.floor(Number(query.limit ?? 500));
  const limit = Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), 500) : 500;
  const page =
    query.page == null ? null : Math.min(Math.max(Math.floor(Number(query.page)) || 1, 1), 10_000);
  const search = query.search?.trim();
  if (query.subsidiaryIds != null && query.subsidiaryIds.length === 0) {
    return { counts: [], totalCount: 0, nextCursor: null };
  }
  const scope = subsidiaryScope(query.subsidiaryIds);
  const after = page == null && query.cursor ? parseListCursor(query.cursor) : null;
  const cursorScope = after
    ? sql`and (c.counted_on < ${after.countedOn}::date
            or (c.counted_on = ${after.countedOn}::date and c.created_at < ${after.createdAt}::timestamptz)
            or (c.counted_on = ${after.countedOn}::date and c.created_at = ${after.createdAt}::timestamptz and c.id > ${after.id}))`
    : sql``;
  const searchScope = search
    ? sql`and (
        position(lower(${search}) in lower(c.counted_on::text)) > 0
        or position(lower(${search}) in lower(c.status::text)) > 0
        or position(lower(${search}) in lower(coalesce(c.memo, ''))) > 0
        or position(lower(${search}) in lower(coalesce(l.name, ''))) > 0
      )`
    : sql``;
  const from = sql`from stock_counts c left join locations l on l.org_id = c.org_id and l.id = c.location_id`;
  const count = (
    await db.execute<{ n: string }>(
      sql`
    select count(*)::text as n ${from} where c.org_id = ${orgId} ${scope} ${searchScope}`,
      "objects",
    )
  )[0]!.n;
  const r = await db.execute<{
    id: string;
    status: string;
    location_id: string;
    location_name: string | null;
    counted_on: string;
    created_at: string;
    memo: string | null;
    line_count: string;
    uncounted_count: string;
    discrepant_count: string;
  }>(
    sql`
    select c.id, c.status, c.location_id, l.name as location_name,
           c.counted_on::text, c.created_at::text, c.memo,
           (select count(*)::text from stock_count_lines l
             where l.org_id = ${orgId} and l.stock_count_id = c.id) as line_count,
           (select count(*)::text from stock_count_lines l
             where l.org_id = ${orgId} and l.stock_count_id = c.id and l.counted_quantity is null) as uncounted_count,
           (select count(*)::text from stock_count_lines l
             where l.org_id = ${orgId} and l.stock_count_id = c.id
               and l.counted_quantity is not null
               and l.counted_quantity <> l.expected_quantity and (not c.blind or c.status in ('review','posted'))) as discrepant_count
      ${from}
     where c.org_id = ${orgId} ${scope} ${searchScope} ${cursorScope}
     order by ${LIST_ORDER}
     limit ${page == null ? limit + 1 : limit}
     ${page == null ? sql`` : sql`offset ${(page - 1) * limit}`}`,
    "objects",
  );
  const hasMore = page == null && r.length > limit;
  const rows = hasMore ? r.slice(0, limit) : r;
  const last = rows[rows.length - 1];
  return {
    counts: rows.map((row) => ({
      id: row.id,
      status: parseCountStatus(row.status),
      locationId: row.location_id,
      locationName: row.location_name,
      countedOn: row.counted_on,
      memo: row.memo,
      lineCount: Number(row.line_count),
      uncountedCount: Number(row.uncounted_count),
      discrepantLineCount: Number(row.discrepant_count),
    })),
    totalCount: Number(count),
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ countedOn: last.counted_on, createdAt: last.created_at, id: last.id }),
          ).toString("base64url")
        : null,
  };
}

export interface StockCountLineDetail extends Omit<CountLine, "expectedQuantity"> {
  expectedQuantity: string | null;
  serialNumber: string | null;
  secondCountRequired: boolean;
  secondCountedQuantity: string | null;
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

export async function getStockCountDetail(
  orgId: string,
  countId: string,
  /** REQUIRED, no default: null is the explicit unrestricted sentinel. */
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<StockCountDetail> {
  // One transaction for the scope gate and every detail read, locking the
  // header first (READ COMMITTED, like loadAsset): a concurrent count
  // reassignment blocks on the lock instead of authorizing the header and
  // then moving the count before the line reads of one response. (A
  // REPEATABLE READ snapshot cannot take the lock: a locking read that meets
  // a concurrent update errors with 40001 instead of waiting.)
  return withOrgTransaction(orgId, async () => {
    const header = await loadCountHeader(db, orgId, countId, true);
    if (allowedSubsidiaryIds !== null && !allowedSubsidiaryIds.has(header.subsidiaryId)) {
      throw new InventoryNotFoundError("not_found");
    }
    const names = (
      await db.execute<{ location_name: string | null; subsidiary_name: string | null }>(
        sql`
      select (select name from locations where org_id = ${orgId} and id = ${header.locationId}) as location_name,
             (select name from subsidiaries where org_id = ${orgId} and id = ${header.subsidiaryId}) as subsidiary_name`,
        "objects",
      )
    )[0];
    const r = await db.execute<{
      id: string;
      item_id: string;
      stock_location_id: string;
      lot_id: string | null;
      serial_id: string | null;
      serial_number: string | null;
      first_counted_quantity: string | null;
      second_counted_quantity: string | null;
      variance_tolerance: string | null;
      expected_quantity: string;
      counted_quantity: string | null;
      adjustment_movement_id: string | null;
      item_code: string | null;
      item_name: string | null;
      stock_location_code: string | null;
      lot_number: string | null;
    }>(
      sql`
      select l.id, l.item_id, l.stock_location_id, l.lot_id, l.serial_id, l.first_counted_quantity::text, l.second_counted_quantity::text, l.variance_tolerance::text,
             (select serial_number from serials where org_id=${orgId} and id=l.serial_id) as serial_number,
             l.expected_quantity::text, l.counted_quantity::text, l.adjustment_movement_id,
             (select code from items where org_id = ${orgId} and id = l.item_id) as item_code,
             (select name from items where org_id = ${orgId} and id = l.item_id) as item_name,
             (select code from stock_locations where org_id = ${orgId} and id = l.stock_location_id) as stock_location_code,
             (select lot_number from lots where org_id = ${orgId} and id = l.lot_id) as lot_number
        from stock_count_lines l
       where l.org_id = ${orgId} and l.stock_count_id = ${header.id}
       order by item_code nulls last, stock_location_code nulls last, l.id`,
      "objects",
    );
    return {
      header: {
        ...header,
        locationName: names?.location_name ?? null,
        subsidiaryName: names?.subsidiary_name ?? null,
      },
      lines: r.map((row) => ({
        id: row.id,
        itemId: row.item_id,
        stockLocationId: row.stock_location_id,
        lotId: row.lot_id,
        serialId: row.serial_id,
        serialNumber: row.serial_number,
        secondCountRequired:
          requiresSecondCount(
            row.expected_quantity,
            row.first_counted_quantity,
            row.variance_tolerance,
          ) && row.second_counted_quantity === null,
        secondCountedQuantity: row.second_counted_quantity,
        expectedQuantity:
          header.blind && !["review", "posted"].includes(header.status)
            ? null
            : row.expected_quantity,
        countedQuantity: row.counted_quantity,
        adjustmentMovementId: row.adjustment_movement_id,
        itemCode: row.item_code,
        itemName: row.item_name,
        stockLocationCode: row.stock_location_code,
        lotNumber: row.lot_number,
        variance:
          row.counted_quantity === null ||
          (header.blind && !["review", "posted"].includes(header.status))
            ? null
            : add(row.counted_quantity, neg(row.expected_quantity)),
      })),
    };
  });
}
