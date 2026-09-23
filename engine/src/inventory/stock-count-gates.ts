import { sql } from "drizzle-orm";
import { add, cmp, neg } from "../money/money.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { InventoryError, InventoryOwnershipError } from "./contracts.ts";
import type { Runner } from "./contracts.ts";
import { assertStockLocationAdmitsSubsidiary } from "./profile-policy.ts";
import type { SubsidiaryContext } from "../organization/subsidiaries.ts";
import { periodForDate, persistReceiptMoney } from "./position.ts";

/**
 * Stock-count validation gates: the pure lifecycle guards (status machine,
 * variance math) and the pre-write validators (date, period, quantities,
 * warehouses). They live apart from the lifecycle in stock-counts.ts so
 * each operation module stays under the inventory file-size bound; the
 * lifecycle re-exports the public names, so importers do not move.
 *
 * Every gate fails closed with a remedy-naming InventoryError — never a
 * bare Error or a storage failure.
 */

export type StockCountStatus = "draft" | "counting" | "review" | "posted" | "cancelled";

const COUNT_TRANSITIONS: Record<StockCountStatus, StockCountStatus[]> = {
  draft: ["counting", "cancelled"],
  counting: ["review", "cancelled"],
  review: ["counting", "posted", "cancelled"],
  posted: [],
  cancelled: [],
};

const TRANSITION_REMEDY: Record<string, string> = {
  "draft:review": "start the count first (draft → counting), record every line, then submit for review",
  "draft:posted": "start the count first (draft → counting), record every line, submit for review, then post",
  "counting:posted": "submit the count for review first (counting → review), then post",
  "counting:counting": "the count is already open for counting",
  "review:review": "the count is already awaiting review",
  "posted:posted": "the count is already posted — counts are immutable once posted; correct with a new count",
  "cancelled:counting": "the count is cancelled — open a new count instead of reusing a cancelled one",
  "posted:counting": "the count is already posted — counts are immutable once posted; correct with a new count",
  "cancelled:review": "the count is cancelled — open a new count instead of reusing a cancelled one",
  "posted:review": "the count is already posted — counts are immutable once posted; correct with a new count",
};

/**
 * Pure transition guard: throws a remedy-naming InventoryError when `to` is
 * not reachable from `from`. Pure so the unit partition can prove every
 * refusal fires without a database.
 */
export function assertCountTransition(from: StockCountStatus, to: StockCountStatus): void {
  if (from === to && (to === "posted" || to === "cancelled")) {
    // Posting twice / cancelling twice are the refusals operators hit most;
    // name them directly rather than falling through to the generic message.
    if (to === "posted") {
      throw new InventoryError(
        "stock count is already posted — counts are immutable once posted; correct with a new count",
      );
    }
    throw new InventoryError("stock count is already cancelled — open a new count instead of reusing a cancelled one");
  }
  if (COUNT_TRANSITIONS[from].includes(to)) return;
  const remedy = TRANSITION_REMEDY[`${from}:${to}`] ?? `move the count from ${from} first`;
  throw new InventoryError(`cannot move stock count from ${from} to ${to} — ${remedy}`);
}

export function parseCountStatus(value: unknown): StockCountStatus {
  if (
    value === "draft" ||
    value === "counting" ||
    value === "review" ||
    value === "posted" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new InventoryError(`unknown stock count status: ${String(value)}`);
}

/**
 * Exact-quantity gate for the stock-count lifecycle. Count quantities land in
 * the same numeric(19,4) columns as every other movement, so they take the
 * same fail-closed shape-and-range gate (InventoryError naming the label,
 * never a bare Error or a storage failure). The rule itself lives in
 * position.ts, once — this is only the count-side name for it.
 */
export const parseCountQuantity = persistReceiptMoney;

/**
 * A physical count is never negative: accepting -1 would review and post a
 * negative variance, and with allow_negative_inventory the position itself
 * could go negative while the count reads posted. Refuse at the engine
 * boundary (record AND variance math), with storage as the backstop (0299).
 */
export function assertCountedNonNegative(counted: string): void {
  if (cmp(counted, "0") < 0) {
    throw new InventoryError(
      "counted quantity cannot be negative — record what was physically on hand (zero or more)",
    );
  }
}

/** Variance is counted − expected, in exact decimal arithmetic (never floats). */
export function countVariance(countedQuantity: string, expectedQuantity: string): string {
  const counted = parseCountQuantity(countedQuantity, "counted quantity");
  assertCountedNonNegative(counted);
  const expected = parseCountQuantity(expectedQuantity, "expected quantity");
  return add(counted, neg(expected));
}

export function assertCountedOn(value: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new InventoryError("count date must be a valid YYYY-MM-DD date");
  }
}

export async function assertPeriodCovers(
  runner: Runner,
  orgId: string,
  countedOn: string,
): Promise<string> {
  const periodId = await periodForDate(orgId, countedOn, runner);
  if (!periodId) {
    throw new InventoryError(
      `no accounting period covers ${countedOn} — set the count date to a date inside an open accounting period`,
    );
  }
  return periodId;
}

/**
 * The warehouse side of count validity: every warehouse on the count must be
 * ACTIVE and admit the count's legal entity — the same gate every movement
 * passes through `assertStockLocationAdmitsSubsidiary`. Without it a draft
 * saves against a dead or foreign warehouse and only dies later inside
 * adjustInventory, or a zero-variance count posts against one silently.
 * The row is locked FOR SHARE and held to the caller's commit, so a
 * deactivation or restriction edit racing create/submit/post serializes
 * against the validation instead of slipping past it.
 */
export async function assertCountWarehouses(
  tx: Runner,
  orgId: string,
  ctx: SubsidiaryContext,
  subsidiaryId: string,
  stockLocationIds: string[],
): Promise<void> {
  for (const stockLocationId of [...new Set(stockLocationIds)].sort()) {
    const row = (await tx.execute<{ code: string | null; is_active: boolean }>(sql`
      select code, is_active
        from stock_locations
       where org_id = ${orgId} and id = ${stockLocationId}
       for share`)).rows[0];
    if (!row) {
      throw new InventoryError(
        "count line stock location not found in this organization — choose an active stock location",
      );
    }
    if (!row.is_active) {
      throw new InventoryError(
        `stock location "${row.code ?? stockLocationId}" is inactive — reactivate the warehouse, or move the count lines to an active one`,
      );
    }
    try {
      await assertStockLocationAdmitsSubsidiary(tx, orgId, ctx, stockLocationId, subsidiaryId);
    } catch (error) {
      if (error instanceof InventoryOwnershipError) {
        throw new InventoryError(
          `${error.message} — count under an admitted subsidiary, or widen the warehouse's subsidiary restriction`,
        );
      }
      throw error;
    }
  }
}

/**
 * Is the org's "require a different user to post stock counts" switch on?
 * Stored at `orgs.settings.approvals.requireStockCountReview`, default OFF
 * (today's self-post behaviour). Absent — or anything but the JSON boolean
 * true — reads as OFF. The comparison is strict text, never a boolean
 * cast: Postgres accepts 'yes'/'on'/'1' as true, so a cast would let junk
 * enable the gate (fail open toward refusals). Mirrors the vendor-bill
 * release policy in flows/vendor-bill-approval.ts.
 */
export async function isStockCountReviewRequired(
  orgId: string,
  executor: Runner,
): Promise<boolean> {
  const rows = (await executor.execute<{ required: boolean | null }>(sql`
    select coalesce((settings->'approvals'->>'requireStockCountReview') = 'true', false) as required
      from orgs where id = ${orgId}
  `)).rows;
  return rows[0]?.required === true;
}

export type CountHeader = {
  id: string;
  status: StockCountStatus;
  locationId: string;
  subsidiaryId: string;
  countedOn: string;
  memo: string | null;
};

export type CountLine = {
  id: string;
  itemId: string;
  stockLocationId: string;
  lotId: string | null;
  expectedQuantity: string;
  countedQuantity: string | null;
  adjustmentMovementId: string | null;
};

export async function loadCountHeader(
  runner: Runner,
  orgId: string,
  countId: string,
  forUpdate: boolean,
): Promise<CountHeader> {
  const lock = forUpdate ? sql` for update` : sql``;
  const r = (await runner.execute<{
    id: string;
    status: string;
    location_id: string;
    subsidiary_id: string;
    counted_on: string;
    memo: string | null;
  }>(sql`select id, status, location_id, subsidiary_id, counted_on::text, memo
            from stock_counts where org_id = ${orgId} and id = ${countId}${lock}`));
  const row = r.rows[0];
  if (!row) {
    // Under RLS an unscoped read silently returns nothing, so a missing row
    // is either a wrong id or another org's count — say both, not "not found".
    throw new InventoryError(
      "stock count not found in this organization — check the count id, or open a new count",
    );
  }
  return {
    id: row.id,
    status: parseCountStatus(row.status),
    locationId: row.location_id,
    subsidiaryId: row.subsidiary_id,
    countedOn: row.counted_on,
    memo: row.memo,
  };
}

export async function loadCountLines(
  runner: Runner,
  orgId: string,
  countId: string,
): Promise<CountLine[]> {
  const r = (await runner.execute<{
    id: string;
    item_id: string;
    stock_location_id: string;
    lot_id: string | null;
    expected_quantity: string;
    counted_quantity: string | null;
    adjustment_movement_id: string | null;
  }>(sql`select id, item_id, stock_location_id, lot_id,
                expected_quantity::text, counted_quantity::text, adjustment_movement_id
           from stock_count_lines
          where org_id = ${orgId} and stock_count_id = ${countId}
          order by item_id, stock_location_id, lot_id nulls first, id`));
  return r.rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    stockLocationId: row.stock_location_id,
    lotId: row.lot_id,
    expectedQuantity: row.expected_quantity,
    countedQuantity: row.counted_quantity,
    adjustmentMovementId: row.adjustment_movement_id,
  }));
}

/** Every UPDATE names its row; a zero-row write is a failure, never success. */
export async function transitionCount(
  runner: Runner,
  orgId: string,
  actorId: string | null,
  count: CountHeader,
  to: StockCountStatus,
): Promise<void> {
  assertCountTransition(count.status, to);
  const updated = (await runner.execute<{ id: string }>(sql`
    update stock_counts set status = ${to}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${count.id} and status = ${count.status}
    returning id`));
  if (updated.rows.length === 0) {
    throw new InventoryError(
      `stock count ${count.id} changed while this action was in flight — reload the count and try again`,
    );
  }
}

export async function requireAllLinesCounted(
  runner: Runner,
  orgId: string,
  countId: string,
): Promise<CountLine[]> {
  const lines = await loadCountLines(runner, orgId, countId);
  if (lines.length === 0) {
    throw new InventoryError("a stock count needs at least one line — add the items to count");
  }
  const missing = lines.filter((l) => l.countedQuantity === null);
  if (missing.length > 0) {
    const first = missing[0]!;
    const detail = (await runner.execute<{ code: string | null; loc: string | null }>(sql`
      select (select code from items where org_id = ${orgId} and id = ${first.itemId}) as code,
             (select code from stock_locations where org_id = ${orgId} and id = ${first.stockLocationId}) as loc`)).rows[0];
    const where = `item ${detail?.code ?? first.itemId} at ${detail?.loc ?? first.stockLocationId}`;
    throw new InventoryError(
      missing.length === 1
        ? `cannot submit: 1 line is still uncounted (${where}) — record its counted quantity first`
        : `cannot submit: ${missing.length} lines are still uncounted (first: ${where}) — record every line's counted quantity first`,
    );
  }
  return lines;
}
