import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, isZero, neg } from "../money/money.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { assertPeriodModulesOpen, CloseError } from "../close/close.ts";
import { adjustInventory } from "./movements.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { getOnHandWith, periodForDate, persistReceiptMoney, primaryBookId } from "./position.ts";

/**
 * Exact-quantity gate for the stock-count lifecycle. Count quantities land in
 * the same numeric(19,4) columns as every other movement, so they take the
 * same fail-closed shape-and-range gate (InventoryError naming the label,
 * never a bare Error or a storage failure). The rule itself lives in
 * position.ts, once — this is only the count-side name for it.
 */
const parseCountQuantity = persistReceiptMoney;

/**
 * Count-basis on-hand for one stock-count line: the SAME layer math as every
 * other reader (lot/serial selection included), scoped to the count's legal
 * entity and, for lot-tracked items, to the line's lot. The lifecycle
 * snapshots `expected_quantity` through here at creation/recount and re-reads
 * through here at posting for the drift check, so the snapshot and the check
 * can never disagree on what "on hand" means.
 */
function getCountBasisQuantity(
  runner: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  selection: { lotId?: string | null; serialId?: string | null; subsidiaryId?: string } = {},
): Promise<{ quantity: string; value: string; unitCost: string }> {
  return getOnHandWith(runner, orgId, itemId, stockLocationId, selection);
}

/**
 * Cycle-count / physical-inventory lifecycle over the `stock_counts` +
 * `stock_count_lines` tables.
 *
 * Posting NEVER writes stock itself: every nonzero variance
 * (countedQuantity − expectedQuantity) is applied through `adjustInventory`,
 * the EXISTING inventory-movement path, so counts inherit its costing,
 * closed-period fence, subsidiary ownership checks, and balanced journal
 * posting unchanged. There is exactly one adjustment path in this module and
 * this file does not add a second.
 *
 * Lifecycle: draft → counting → review → posted, with cancelled reachable
 * from draft/counting/review and review → counting for recounts. The
 * transitions are explicit because a count is financial evidence: a posted
 * count is immutable, and a correction is a NEW count (or a movement
 * reversal through the existing reversal path), never an edit.
 *
 * Concurrency note: checks and the status flip run row-locked, but each
 * variance adjustment commits in its own movement transaction (that is what
 * "through the existing movement path" means). Two operators posting the
 * same count concurrently are serialized by the HTTP idempotency boundary
 * (`inventory.stock-count.post` keyed on the count); direct engine callers
 * must serialize post per count. A stock movement landing in the seconds-long
 * post window after the drift check is caught on the NEXT count, not this
 * one — counts are taken over a frozen area, and the drift refusal exists
 * to catch everything up to the post.
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

/** Variance is counted − expected, in exact decimal arithmetic (never floats). */
export function countVariance(countedQuantity: string, expectedQuantity: string): string {
  const counted = parseCountQuantity(countedQuantity, "counted quantity");
  const expected = parseCountQuantity(expectedQuantity, "expected quantity");
  return add(counted, neg(expected));
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

type CountHeader = {
  id: string;
  status: StockCountStatus;
  locationId: string;
  subsidiaryId: string;
  countedOn: string;
  memo: string | null;
};

type CountLine = {
  id: string;
  itemId: string;
  stockLocationId: string;
  lotId: string | null;
  expectedQuantity: string;
  countedQuantity: string | null;
  adjustmentMovementId: string | null;
};

async function loadCountHeader(
  runner: Pick<typeof db, "execute">,
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

async function loadCountLines(
  runner: Pick<typeof db, "execute">,
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
async function transitionCount(
  runner: Pick<typeof db, "execute">,
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

function assertCountedOn(value: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new InventoryError("count date must be a valid YYYY-MM-DD date");
  }
}

async function assertPeriodCovers(
  runner: Pick<typeof db, "execute">,
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

export interface NewCountLineInput {
  itemId: string;
  stockLocationId: string;
  lotId?: string | null;
}

export interface CreateStockCountInput {
  locationId: string;
  /** Owning legal entity, stored on the row (0200): the snapshot, the drift
   * check, and every adjustment movement scope to it — never inferred from
   * the posting session. */
  subsidiaryId: string;
  countedOn: string;
  memo?: string | null;
  lines: NewCountLineInput[];
}

/**
 * Open a draft count, snapshotting each line's expected quantity from live
 * on-hand (count-entity scoped, lot scoped for lot-tracked items) at creation.
 * The snapshot is the baseline the posting drift check compares against.
 */
export async function createStockCount(
  orgId: string,
  actorId: string | null,
  input: CreateStockCountInput,
): Promise<{ id: string; status: StockCountStatus }> {
  assertCountedOn(input.countedOn);
  if (input.lines.length === 0) {
    throw new InventoryError("a stock count needs at least one line — add the items to count");
  }
  if (input.lines.length > 2000) {
    throw new InventoryError("a stock count holds at most 2000 lines — split the count by area");
  }
  return db.transaction(async (tx) => {
    await assertPeriodCovers(tx, orgId, input.countedOn);
    const location = (await tx.execute<{ id: string }>(sql`
      select id from locations where org_id = ${orgId} and id = ${input.locationId}`));
    if (!location.rows[0]) {
      throw new InventoryError("count location not found in this organization — choose an active business location");
    }
    const subsidiary = (await tx.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and id = ${input.subsidiaryId}`));
    if (!subsidiary.rows[0]) {
      throw new InventoryError("count subsidiary not found in this organization — choose an active subsidiary");
    }
    // Validate every subject against the org BEFORE snapshotting: a line
    // scoped to another org's item, or to a stock location outside the
    // count's business location, must refuse by name rather than die on a
    // foreign key. Serial-tracked items cannot be counted by quantity at
    // all; lot-tracked items must name their lot.
    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const items = (await tx.execute<{ id: string }>(sql`
      select it.id from items it where it.org_id = ${orgId} and it.id = any(${itemIds}::uuid[])`));
    const foundItems = new Set(items.rows.map((r) => r.id));
    const profiles = (await tx.execute<{ item_id: string; tracking: string }>(sql`
      select item_id, tracking from item_inventory_profiles
       where org_id = ${orgId} and item_id = any(${itemIds}::uuid[])`));
    const trackingByItem = new Map(profiles.rows.map((r) => [r.item_id, r.tracking]));
    const stockLocationIds = [...new Set(input.lines.map((l) => l.stockLocationId))];
    const stockLocations = (await tx.execute<{ id: string; location_id: string }>(sql`
      select id, location_id from stock_locations
       where org_id = ${orgId} and id = any(${stockLocationIds}::uuid[])`));
    const businessByStockLocation = new Map(stockLocations.rows.map((r) => [r.id, r.location_id]));
    const countId = randomUUID();
    await tx.execute(sql`
      insert into stock_counts (id, org_id, location_id, subsidiary_id, status, counted_on, memo, created_by, updated_by)
      values (${countId}, ${orgId}, ${input.locationId}, ${input.subsidiaryId},
              'draft', ${input.countedOn}, ${input.memo ?? null}, ${actorId}, ${actorId})`);
    for (const line of input.lines) {
      if (!foundItems.has(line.itemId)) {
        throw new InventoryError("count line item not found in this organization — choose an active item");
      }
      const tracking = trackingByItem.get(line.itemId);
      if (!tracking) {
        throw new InventoryError(
          "count line item has no inventory profile — create its item inventory profile before counting it",
        );
      }
      if (tracking === "serial") {
        throw new InventoryError(
          "serial-tracked items cannot be cycle-counted by quantity — count them by serial scan instead",
        );
      }
      if (tracking === "lot" && !line.lotId) {
        throw new InventoryError("lot-tracked items must be counted per lot — supply the lot for this line");
      }
      const businessLocation = businessByStockLocation.get(line.stockLocationId);
      if (!businessLocation) {
        throw new InventoryError("count line stock location not found in this organization — choose an active stock location");
      }
      if (businessLocation !== input.locationId) {
        throw new InventoryError(
          "count line stock location belongs to a different business location — open a separate count for that location",
        );
      }
      if (line.lotId) {
        const lot = (await tx.execute<{ id: string }>(sql`
          select id from lots where org_id = ${orgId} and id = ${line.lotId} and item_id = ${line.itemId}`));
        if (!lot.rows[0]) {
          throw new InventoryError("count line lot does not belong to the line's item — choose the item's own lot");
        }
      }
      const basis = await getCountBasisQuantity(tx, orgId, line.itemId, line.stockLocationId, {
        lotId: line.lotId ?? null,
        subsidiaryId: input.subsidiaryId,
      });
      await tx.execute(sql`
        insert into stock_count_lines
          (id, org_id, stock_count_id, item_id, stock_location_id, lot_id,
           expected_quantity, counted_quantity, created_by, updated_by)
        values (${randomUUID()}, ${orgId}, ${countId}, ${line.itemId}, ${line.stockLocationId},
                ${line.lotId ?? null}, ${basis.quantity}, null, ${actorId}, ${actorId})`);
    }
    return { id: countId, status: "draft" as StockCountStatus };
  });
}

export async function startStockCount(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, countId, true);
    await transitionCount(tx, orgId, actorId, count, "counting");
    return { id: count.id, status: "counting" as StockCountStatus };
  });
}

/** Record (or correct, while counting) a line's observed quantity. */
export async function recordCountedQuantity(
  orgId: string,
  actorId: string | null,
  input: { countId: string; lineId: string; countedQuantity: string },
): Promise<{ lineId: string; variance: string }> {
  const counted = parseCountQuantity(input.countedQuantity, "counted quantity");
  return db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, input.countId, true);
    if (count.status !== "counting") {
      if (count.status === "review") {
        throw new InventoryError(
          "count is awaiting review — send it back to counting before changing counted quantities",
        );
      }
      assertCountTransition(count.status, "counting");
    }
    const line = (await tx.execute<{ id: string; expected_quantity: string; adjustment_movement_id: string | null }>(sql`
      select id, expected_quantity::text, adjustment_movement_id
        from stock_count_lines
       where org_id = ${orgId} and id = ${input.lineId} and stock_count_id = ${count.id}
       for update`)).rows[0];
    if (!line) {
      throw new InventoryError("count line not found on this count — reload the count and try again");
    }
    if (line.adjustment_movement_id) {
      throw new InventoryError(
        "line already posted an inventory adjustment — correct it with a new count, not an edit",
      );
    }
    const updated = (await tx.execute<{ id: string }>(sql`
      update stock_count_lines set counted_quantity = ${counted}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${line.id}
      returning id`));
    if (updated.rows.length === 0) {
      throw new InventoryError("count line changed while this action was in flight — reload the count and try again");
    }
    return { lineId: line.id, variance: add(counted, neg(line.expected_quantity)) };
  });
}

/**
 * Re-snapshot a line's expected quantity from live on-hand (counting only).
 * The old counted value, if any, is cleared: it was observed against a stale
 * baseline and re-recording is the remedy, not silent reuse.
 */
export async function recountStockCountLine(
  orgId: string,
  actorId: string | null,
  input: { countId: string; lineId: string },
): Promise<{ lineId: string; expectedQuantity: string }> {
  return db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, input.countId, true);
    if (count.status !== "counting") {
      throw new InventoryError(
        `cannot recount while the count is ${count.status} — send the count back to counting first`,
      );
    }
    const line = (await tx.execute<{
      id: string;
      item_id: string;
      stock_location_id: string;
      lot_id: string | null;
      adjustment_movement_id: string | null;
    }>(sql`
      select id, item_id, stock_location_id, lot_id, adjustment_movement_id
        from stock_count_lines
       where org_id = ${orgId} and id = ${input.lineId} and stock_count_id = ${count.id}
       for update`)).rows[0];
    if (!line) {
      throw new InventoryError("count line not found on this count — reload the count and try again");
    }
    if (line.adjustment_movement_id) {
      throw new InventoryError(
        "line already posted an inventory adjustment — correct it with a new count, not an edit",
      );
    }
    const basis = await getCountBasisQuantity(tx, orgId, line.item_id, line.stock_location_id, {
      lotId: line.lot_id,
      subsidiaryId: count.subsidiaryId,
    });
    const updated = (await tx.execute<{ id: string }>(sql`
      update stock_count_lines
         set expected_quantity = ${basis.quantity}, counted_quantity = null,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${line.id}
      returning id`));
    if (updated.rows.length === 0) {
      throw new InventoryError("count line changed while this action was in flight — reload the count and try again");
    }
    return { lineId: line.id, expectedQuantity: basis.quantity };
  });
}

async function requireAllLinesCounted(
  runner: Pick<typeof db, "execute">,
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

export async function submitStockCountForReview(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, countId, true);
    if (count.status !== "counting") {
      assertCountTransition(count.status, "review");
    }
    await requireAllLinesCounted(tx, orgId, count.id);
    await transitionCount(tx, orgId, actorId, count, "review");
    return { id: count.id, status: "review" as StockCountStatus };
  });
}

export async function returnStockCountToCounting(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, countId, true);
    await transitionCount(tx, orgId, actorId, count, "counting");
    return { id: count.id, status: "counting" as StockCountStatus };
  });
}

/** Move the count date (draft/counting/review). The remedy the closed-period
 * refusal names must exist — this is it, alongside reopening the period. */
export async function setStockCountDate(
  orgId: string,
  actorId: string | null,
  input: { countId: string; countedOn: string },
): Promise<{ id: string; countedOn: string }> {
  assertCountedOn(input.countedOn);
  return db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, input.countId, true);
    if (count.status !== "draft" && count.status !== "counting" && count.status !== "review") {
      throw new InventoryError(
        `cannot change the date of a ${count.status} count — counts are immutable once posted; open a new count`,
      );
    }
    await assertPeriodCovers(tx, orgId, input.countedOn);
    const updated = (await tx.execute<{ id: string }>(sql`
      update stock_counts set counted_on = ${input.countedOn}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${count.id}
      returning id`));
    if (updated.rows.length === 0) {
      throw new InventoryError("stock count changed while this action was in flight — reload the count and try again");
    }
    return { id: count.id, countedOn: input.countedOn };
  });
}

export async function cancelStockCount(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, countId, true);
    const postedLines = (await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from stock_count_lines
       where org_id = ${orgId} and stock_count_id = ${count.id} and adjustment_movement_id is not null`));
    if (postedLines.rows[0]?.n !== "0") {
      throw new InventoryError(
        "cannot cancel a count that already posted adjustments — correct with a new count",
      );
    }
    await transitionCount(tx, orgId, actorId, count, "cancelled");
    return { id: count.id, status: "cancelled" as StockCountStatus };
  });
}

export interface PostedLineResult {
  lineId: string;
  variance: string;
  movementId: string | null;
  entryId: string | null;
}

export interface PostStockCountResult {
  id: string;
  status: StockCountStatus;
  lines: PostedLineResult[];
}

/**
 * Post a reviewed count. Every nonzero variance becomes one `adjustInventory`
 * movement dated on the count date; zero-variance lines post nothing. Lines
 * that already carry an adjustment (a resumed post after a partial failure)
 * are skipped, so retrying a half-posted count never double-applies.
 *
 * Refusals, each naming its remedy:
 * - not in review → finish the lifecycle first (or: already posted, immutable);
 * - an uncounted line → record every line, then re-submit;
 * - count date in a closed period → reopen the period or move the count date;
 * - expected quantity drifted since the snapshot → send back to counting and
 *   recount the drifted line(s).
 */
export async function postStockCount(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<PostStockCountResult> {
  // Checks run row-locked; the adjustments that follow commit in their own
  // movement transactions (see module note on concurrent posters).
  const prepared = await db.transaction(async (tx) => {
    const count = await loadCountHeader(tx, orgId, countId, true);
    if (count.status === "posted") {
      throw new InventoryError(
        "stock count is already posted — counts are immutable once posted; correct with a new count",
      );
    }
    if (count.status !== "review") {
      assertCountTransition(count.status, "posted");
    }
    const periodId = await assertPeriodCovers(tx, orgId, count.countedOn);
    const bookId = await primaryBookId(orgId, tx);
    try {
      await assertPeriodModulesOpen(tx, {
        orgId,
        periodId,
        bookId,
        subsidiaryIds: [count.subsidiaryId],
        modules: [],
      });
    } catch (error) {
      if (error instanceof CloseError) {
        throw new InventoryError(
          `count date ${count.countedOn} falls in a closed period — reopen the period, or move the count date to an open period and post again`,
        );
      }
      throw error;
    }
    const lines = await requireAllLinesCounted(tx, orgId, count.id);
    // Drift check under the count-row lock: live on-hand (same basis reader
    // as the snapshot) must still equal the snapshot, line by line. Lines
    // that already posted are durable evidence and exempt — re-checking them
    // against live stock would mistake our own posted adjustment for drift.
    const drifted: { line: CountLine; live: string }[] = [];
    for (const line of lines) {
      if (line.adjustmentMovementId) continue;
      const live = await getCountBasisQuantity(tx, orgId, line.itemId, line.stockLocationId, {
        lotId: line.lotId,
        subsidiaryId: count.subsidiaryId,
      });
      if (cmp(live.quantity, line.expectedQuantity) !== 0) {
        drifted.push({ line, live: live.quantity });
      }
    }
    if (drifted.length > 0) {
      const first = drifted[0]!;
      const detail = (await tx.execute<{ code: string | null; loc: string | null }>(sql`
        select (select code from items where org_id = ${orgId} and id = ${first.line.itemId}) as code,
               (select code from stock_locations where org_id = ${orgId} and id = ${first.line.stockLocationId}) as loc`)).rows[0];
      const where = `item ${detail?.code ?? first.line.itemId} at ${detail?.loc ?? first.line.stockLocationId}`;
      throw new InventoryError(
        drifted.length === 1
          ? `cannot post: expected quantity drifted for ${where} (snapshot ${first.line.expectedQuantity}, on hand now ${first.live}) — send the count back to counting, recount the line, and re-submit`
          : `cannot post: expected quantity drifted for ${drifted.length} lines (first: ${where}, snapshot ${first.line.expectedQuantity}, on hand now ${first.live}) — send the count back to counting, recount the drifted lines, and re-submit`,
      );
    }
    return { count, lines };
  });

  const results: PostedLineResult[] = [];
  let firstEntryId: string | null = null;
  for (const line of prepared.lines) {
    const variance = countVariance(line.countedQuantity!, line.expectedQuantity);
    if (isZero(variance)) {
      results.push({ lineId: line.id, variance, movementId: null, entryId: null });
      continue;
    }
    if (line.adjustmentMovementId) {
      results.push({ lineId: line.id, variance, movementId: line.adjustmentMovementId, entryId: null });
      continue;
    }
    let movementId: string;
    let entryId: string | null;
    try {
      const posted = await adjustInventory(orgId, actorId, {
        itemId: line.itemId,
        stockLocationId: line.stockLocationId,
        quantityDelta: variance,
        subsidiaryId: prepared.count.subsidiaryId,
        date: prepared.count.countedOn,
        lotId: line.lotId,
        memo: `Stock count ${prepared.count.id}`,
        locationId: prepared.count.locationId,
      });
      movementId = posted.movementId;
      entryId = posted.entryId;
    } catch (error) {
      if (error instanceof InventoryError && /closed/i.test(error.message)) {
        throw new InventoryError(
          `count date ${prepared.count.countedOn} falls in a closed period — reopen the period, or move the count date to an open period and post again (already-posted lines are kept and skipped on retry)`,
        );
      }
      throw error;
    }
    const stamped = (await db.execute<{ id: string }>(sql`
      update stock_count_lines set adjustment_movement_id = ${movementId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${line.id} and adjustment_movement_id is null
      returning id`));
    if (stamped.rows.length === 0) {
      // A rival post stamped this line first: its adjustment stands, ours
      // would double-apply, so refuse rather than record a second movement.
      // (Our movement already committed through the movement path; unwind it
      // through the existing reversal path is the operator's remedy — the
      // message says so.)
      throw new InventoryError(
        `count line ${line.id} was posted by another action while this post was in flight — ` +
          `reverse movement ${movementId} through the inventory reversal action if it should not stand, then reload the count`,
      );
    }
    if (firstEntryId === null) firstEntryId = entryId;
    results.push({ lineId: line.id, variance, movementId, entryId });
  }

  // Conditional flip: only a count still in review becomes posted. A rival
  // that flipped first turns this into the already-posted refusal — a write
  // matching zero rows is a failure, never a silent success.
  const flipped = (await db.execute<{ id: string }>(sql`
    update stock_counts
       set status = 'posted', posted_entry_id = coalesce(${firstEntryId}, posted_entry_id),
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${prepared.count.id} and status = 'review'
    returning id`));
  if (flipped.rows.length === 0) {
    throw new InventoryError(
      "stock count left review while this post was in flight — reload the count; lines already stamped keep their adjustments and are skipped on retry",
    );
  }
  return { id: prepared.count.id, status: "posted", lines: results };
}

// ---------------------------------------------------------------------------
// Readers (list + detail for the API and the counts page)
// ---------------------------------------------------------------------------

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

