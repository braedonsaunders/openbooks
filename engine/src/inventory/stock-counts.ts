import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, orgContext } from "../platform/db.ts";
import { add, cmp, isZero, neg } from "../money/money.ts";
import { assertPeriodModulesOpen, CloseError } from "../close/period-policy.ts";
import { adjustInventory } from "./movements.ts";
import { loadSubsidiaryContext, uuidArray } from "../organization/subsidiaries.ts";
import { assertInventoryFeature } from "./profile-policy.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { getOnHandWith, lockInventoryPosition, primaryBookId } from "./position.ts";
import {
  assertCountedNonNegative,
  assertCountedOn,
  assertCountTransition,
  assertCountWarehouses,
  assertPeriodCovers,
  countVariance,
  isStockCountReviewRequired,
  loadCountHeader,
  parseCountQuantity,
  requireAllLinesCounted,
  transitionCount,
} from "./stock-count-gates.ts";
import type { CountLine, StockCountStatus } from "./stock-count-gates.ts";
import { auditCountedChange, countedChangeReason } from "./stock-count-observations.ts";

// The validation gates live in stock-count-gates.ts and the observation
// audit in stock-count-observations.ts (the inventory file-size bound).
// The public names stay importable from here so callers do not move.
export {
  assertCountTransition,
  assertCountedNonNegative,
  countVariance,
  loadCountHeader,
  parseCountStatus,
} from "./stock-count-gates.ts";
export type { CountHeader, CountLine, StockCountStatus } from "./stock-count-gates.ts";

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
 * Atomicity note: the whole post — checks, every variance adjustment,
 * every line stamp, and the status flip — commits in ONE caller-owned
 * transaction. The production path (`inventory.stock-count.post` through
 * `executeIdempotentInventoryAction`, which runs inside `withOrgTransaction`)
 * pins that unit, and nested `db.transaction` calls join it rather than
 * opening their own, so a failure anywhere rolls every movement, stamp and
 * flip back together: a reviewed count never half-posts, and a retry never
 * double-applies. Two operators posting the same count concurrently are
 * serialized by the HTTP idempotency boundary (keyed on the count); direct
 * engine callers must run one post per count inside `withOrgTransaction` —
 * called outside an ambient transaction, postStockCount refuses rather than
 * post partially. A stock movement racing the post either commits before
 * the drift re-read — and the re-read refuses as drifted — or waits out
 * the position locks the post holds from the re-read to the outer commit
 * and lands after it, to be caught on the NEXT count. Counts are taken
 * over a frozen area, and the drift refusal exists to catch everything up
 * to the post; no movement can slip between the re-read and the
 * adjustments.
 */

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
    await assertInventoryFeature(tx, orgId);
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
    const items = (await tx.execute<{ id: string; code: string | null }>(sql`
      select it.id, it.code from items it where it.org_id = ${orgId} and it.id = any(${uuidArray(itemIds)}::uuid[])`));
    const foundItems = new Set(items.rows.map((r) => r.id));
    const itemCodes = new Map(items.rows.map((r) => [r.id, r.code]));
    const profiles = (await tx.execute<{ item_id: string; tracking: string }>(sql`
      select item_id, tracking from item_inventory_profiles
       where org_id = ${orgId} and item_id = any(${uuidArray(itemIds)}::uuid[])`));
    const trackingByItem = new Map(profiles.rows.map((r) => [r.item_id, r.tracking]));
    const stockLocationIds = [...new Set(input.lines.map((l) => l.stockLocationId))];
    const stockLocations = (await tx.execute<{ id: string; location_id: string; code: string | null }>(sql`
      select id, location_id, code from stock_locations
       where org_id = ${orgId} and id = any(${uuidArray(stockLocationIds)}::uuid[])`));
    const businessByStockLocation = new Map(stockLocations.rows.map((r) => [r.id, r.location_id]));
    const stockLocationCodes = new Map(stockLocations.rows.map((r) => [r.id, r.code]));
    // One line per (item, stock location, lot) subject: duplicate lines
    // would each post the full variance and double-apply one observation.
    // Constraint 0293 arbitrates concurrent writers; this names the offender.
    const seenSubjects = new Set<string>();
    for (const line of input.lines) {
      const subject = `${line.itemId}|${line.stockLocationId}|${line.lotId ?? ""}`;
      if (seenSubjects.has(subject)) {
        const where = `item ${itemCodes.get(line.itemId) ?? line.itemId} at ${stockLocationCodes.get(line.stockLocationId) ?? line.stockLocationId}${line.lotId ? ` lot ${line.lotId}` : ""}`;
        throw new InventoryError(
          `duplicate count line for ${where} — count each item, stock location and lot once`,
        );
      }
      seenSubjects.add(subject);
    }
    // The warehouses must be active and admit the count's subsidiary BEFORE
    // any draft is stored: otherwise the draft reaches review and dies in
    // adjustInventory, or a zero-variance count posts against a dead or
    // foreign warehouse silently.
    await assertCountWarehouses(
      tx,
      orgId,
      await loadSubsidiaryContext(tx, orgId),
      input.subsidiaryId,
      stockLocationIds,
    );
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
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, countId, true);
    await transitionCount(tx, orgId, actorId, count, "counting");
    return { id: count.id, status: "counting" as StockCountStatus };
  });
}

/** Record (or correct, while counting) a line's observed quantity. */
export async function recordCountedQuantity(
  orgId: string,
  actorId: string | null,
  input: { countId: string; lineId: string; countedQuantity: string; reason?: string | null },
): Promise<{ lineId: string; variance: string }> {
  const counted = parseCountQuantity(input.countedQuantity, "counted quantity");
  assertCountedNonNegative(counted);
  return db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, input.countId, true);
    if (count.status !== "counting") {
      if (count.status === "review") {
        throw new InventoryError(
          "count is awaiting review — send it back to counting before changing counted quantities",
        );
      }
      assertCountTransition(count.status, "counting");
    }
    const line = (await tx.execute<{
      id: string;
      expected_quantity: string;
      counted_quantity: string | null;
      adjustment_movement_id: string | null;
    }>(sql`
      select id, expected_quantity::text, counted_quantity::text, adjustment_movement_id
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
    // Overwriting an observation destroys evidence of what the first
    // counter saw: the before/after trail (with the correction reason)
    // commits atomically with the change, and survives posting.
    await auditCountedChange(tx, orgId, actorId, {
      lineId: line.id,
      countId: count.id,
      operation: "record",
      reason: countedChangeReason(
        input.reason,
        line.counted_quantity === null ? null : "correction of the prior observation",
      ),
      before: { countedQuantity: line.counted_quantity, expectedQuantity: line.expected_quantity },
      after: { countedQuantity: counted, expectedQuantity: line.expected_quantity },
    });
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
  input: { countId: string; lineId: string; reason?: string | null },
): Promise<{ lineId: string; expectedQuantity: string }> {
  return db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
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
      expected_quantity: string;
      counted_quantity: string | null;
      adjustment_movement_id: string | null;
    }>(sql`
      select id, item_id, stock_location_id, lot_id, expected_quantity::text, counted_quantity::text,
             adjustment_movement_id
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
    // A recount clears the prior observation: the discarded before-image
    // commits its audit row atomically with the clear, and survives posting.
    await auditCountedChange(tx, orgId, actorId, {
      lineId: line.id,
      countId: count.id,
      operation: "recount",
      reason: countedChangeReason(input.reason, "recount: re-snapshotted the baseline, prior observation cleared"),
      before: { countedQuantity: line.counted_quantity, expectedQuantity: line.expected_quantity },
      after: { countedQuantity: null, expectedQuantity: basis.quantity },
    });
    return { lineId: line.id, expectedQuantity: basis.quantity };
  });
}

export async function submitStockCountForReview(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, countId, true);
    if (count.status !== "counting") {
      assertCountTransition(count.status, "review");
    }
    const submitLines = await requireAllLinesCounted(tx, orgId, count.id);
    // Re-validate: a warehouse deactivated or restricted after creation must
    // refuse here with a named remedy instead of stranding the count in
    // review (or dying later inside adjustInventory at post).
    await assertCountWarehouses(
      tx,
      orgId,
      await loadSubsidiaryContext(tx, orgId),
      count.subsidiaryId,
      submitLines.map((line) => line.stockLocationId),
    );
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
    await assertInventoryFeature(tx, orgId);
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
    await assertInventoryFeature(tx, orgId);
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
    await assertInventoryFeature(tx, orgId);
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
 * that already carry an adjustment (a rival post stamped first) are skipped,
 * so a retry never double-applies — and a failure anywhere rolls the whole
 * post back, so there is no half-posted count to resume.
 *
 * Refusals, each naming its remedy:
 * - outside a caller-owned transaction → post through the inventory action
 *   boundary (executeIdempotentInventoryAction), which pins the atomic unit;
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
  // The checks, adjustments, stamps and status flip below must commit as one
  // atomic unit. Nested db.transaction calls join the caller's pinned unit;
  // without one they would open several independent commits and half-post.
  // Refuse that shape by name instead of posting partially.
  if (!orgContext.getStore()?.txDb) {
    throw new InventoryError(
      "stock count posting needs its caller's transaction — post through the inventory action boundary " +
        "(executeIdempotentInventoryAction), which holds the checks, adjustments, stamps and status flip in one atomic unit",
    );
  }
  // Checks run row-locked inside the caller's transaction; the adjustments,
  // stamps and flip below join that same unit (see the module atomicity note).
  const prepared = await db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, countId, true);
    if (count.status === "posted") {
      throw new InventoryError(
        "stock count is already posted — counts are immutable once posted; correct with a new count",
      );
    }
    if (count.status !== "review") {
      assertCountTransition(count.status, "posted");
    }
    // Maker/checker (CTRL-01 pattern): when the org requires independent
    // review, the actor who recorded or submitted the count cannot post it.
    // Contributors are everyone who created, transitioned, or recorded on
    // the count; the refusal names the poster, and the audit row after the
    // flip records the review evidence either way.
    const reviewRequired = await isStockCountReviewRequired(orgId, tx);
    const contributors = (await tx.execute<{ actor: string }>(sql`
      select distinct actor from (
        select created_by as actor from stock_counts where org_id = ${orgId} and id = ${count.id}
        union
        select updated_by as actor from stock_counts where org_id = ${orgId} and id = ${count.id}
        union
        select updated_by as actor from stock_count_lines where org_id = ${orgId} and stock_count_id = ${count.id}
      ) actors where actor is not null`)).rows.map((row) => row.actor);
    if (reviewRequired) {
      if (!actorId) {
        throw new InventoryError(
          "posting this stock count requires independent review — post with a named user account, not an automated one",
        );
      }
      if (contributors.includes(actorId)) {
        const poster = (await tx.execute<{ name: string }>(sql`
          select name from users where org_id = ${orgId} and id = ${actorId}`)).rows[0]?.name?.trim() || actorId;
        throw new InventoryError(
          `${poster} recorded or submitted this count — independent review is required: a different user with count-posting authority must post it`,
        );
      }
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
    // Re-validate before posting too: a restriction edited after review
    // refuses here with a named remedy and no adjustment, instead of dying
    // inside adjustInventory mid-post. Warehouses first, then positions —
    // the same order everywhere, so concurrent validators cannot deadlock.
    await assertCountWarehouses(
      tx,
      orgId,
      await loadSubsidiaryContext(tx, orgId),
      count.subsidiaryId,
      lines.map((line) => line.stockLocationId),
    );
    // Every movement writer (receive, issue, adjust, transfer, build)
    // serializes on the position advisory lock, so take every line position
    // in deterministic order BEFORE the drift re-read and hold the locks to
    // the outer commit (advisory xact locks release only there). A movement
    // racing the post then either commits first — and the re-read below
    // refuses as drifted — or waits out the whole post and lands after it.
    // Without these locks the re-read observed a torn area: a movement
    // committing between the check and the adjustments posted a stale
    // variance with no refusal. Lot-tracked lines share their position's
    // key, so they are covered by the same lock (serial-tracked items
    // cannot be counted at all, and refuse at creation).
    for (const key of [
      ...new Set(lines.map((line) => `${line.itemId}:${line.stockLocationId}`)),
    ].sort()) {
      const separator = key.indexOf(":");
      await lockInventoryPosition(tx, key.slice(0, separator), key.slice(separator + 1));
    }
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
    return { count, lines, reviewRequired, contributors };
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
          `count date ${prepared.count.countedOn} falls in a closed period — reopen the period, or move the count date to an open period and post again (nothing posted: the whole post rolls back together)`,
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
      // Our adjustment joined this same transaction and rolls back with it —
      // nothing stands and nothing needs unwinding; reload and retry.
      throw new InventoryError(
        `count line ${line.id} was posted by another action while this post was in flight — ` +
          `reload the count and retry; this attempt's adjustment was rolled back with it`,
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
  // Review evidence either way, in the same atomic unit: who posted, who
  // contributed, and the total variance — or the explicit note that no
  // independent review happened.
  const totalVariance = results.reduce((sum, line) => add(sum, line.variance), "0");
  const reviewed = (await db.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'stock_counts', ${prepared.count.id}, 'update',
            ${JSON.stringify({
              operation: "post",
              review: {
                required: prepared.reviewRequired,
                postedBy: actorId,
                contributors: [...prepared.contributors].sort(),
                totalVariance,
                lineCount: results.length,
              },
              ...(prepared.reviewRequired ? {} : { note: "posted without independent review" }),
            })}::jsonb,
            ${actorId})
    returning id`));
  if (reviewed.rows.length === 0) {
    throw new InventoryError("stock count post was not audited — reload the count and try again");
  }
  return { id: prepared.count.id, status: "posted", lines: results };
}

