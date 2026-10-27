import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { routeStockCount, cancelStockCountRouting } from "./stock-count-approval.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { requireExecutionConfirmation } from "./execution-authority.ts";
import { assertSecondCounts } from "./count-policy.ts";
import { sql } from "drizzle-orm";
import { db, orgContext, withOrgTransaction } from "../platform/db.ts";
import { add, cmp, isZero, neg } from "../money/money.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";
import { adjustInventory } from "./movements.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { assertInventoryFeature } from "./profile-policy.ts";
import { InventoryCostBasisError, InventoryError, InventoryNotFoundError } from "./contracts.ts";
import { getOnHandWith, lockInventoryPosition, primaryBookId } from "./position.ts";
import {
  assertCountedNonNegative,
  assertCountedOn,
  assertCountTransition,
  assertCountWarehouses,
  assertPeriodCovers,
  countVariance,
  loadCountHeader,
  parseCountQuantity,
  requireAllLinesCounted,
  transitionCount,
} from "./stock-count-gates.ts";
import type { CountLine, StockCountStatus } from "./stock-count-gates.ts";
import { auditCountedChange, countedChangeReason } from "./stock-count-observations.ts";
import { executeIdempotentInventoryAction } from "./action-idempotency.ts";

/** Run one count mutation with its organization-scoped ownership lock. */
export async function executeScopedStockCountAction<T>(opts: {
  orgId: string;
  actorId: string;
  countId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  operation: string;
  idempotencyKey: string | null | undefined;
  request: unknown;
  execute: () => Promise<T>;
}): Promise<{ value: T; replayed: boolean }> {
  return withOrgTransaction(opts.orgId, async () => {
    const rows = await db.execute<{ subsidiary_id: string }>(
      sql`select subsidiary_id from stock_counts where id = ${opts.countId} and org_id = ${opts.orgId} for update`,
      "objects",
    );
    const subsidiaryId = rows[0]?.subsidiary_id ?? null;
    if (
      !subsidiaryId ||
      (opts.allowedSubsidiaryIds && !opts.allowedSubsidiaryIds.has(subsidiaryId))
    ) {
      throw new InventoryNotFoundError("not_found");
    }
    return executeIdempotentInventoryAction(opts.orgId, opts.actorId, {
      operation: opts.operation,
      idempotencyKey: opts.idempotencyKey,
      request: opts.request,
      execute: opts.execute,
    });
  });
}

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
// Draft creation and its subject validation live in stock-count-creation.ts.
export { createStockCount } from "./stock-count-creation.ts";
export type { CreateStockCountInput, NewCountLineInput } from "./stock-count-creation.ts";

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
  input: {
    countId: string;
    lineId: string;
    countedQuantity: string;
    reason?: string | null;
    executionTaskId?: string;
  },
): Promise<{ lineId: string; variance: string | null }> {
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
    const line = (
      await tx.execute<{
        id: string;
        expected_quantity: string;
        serial_id: string | null;
        counted_quantity: string | null;
        adjustment_movement_id: string | null;
      }>(
        sql`
      select id, serial_id, expected_quantity::text, counted_quantity::text, adjustment_movement_id
        from stock_count_lines
       where org_id = ${orgId} and id = ${input.lineId} and stock_count_id = ${count.id}
       for update`,
        "objects",
      )
    )[0];
    if (!line) {
      throw new InventoryError(
        "count line not found on this count — reload the count and try again",
      );
    }
    if (line.adjustment_movement_id) {
      throw new InventoryError(
        "line already posted an inventory adjustment — correct it with a new count, not an edit",
      );
    }
    await requireExecutionConfirmation(tx, orgId, {
      stage: "count",
      taskId: input.executionTaskId,
      lineId: line.id,
      quantity: counted,
      observation: "first",
    });
    if (line.serial_id && cmp(counted, "0") !== 0 && cmp(counted, "1") !== 0)
      throw new InventoryError("Count one serial as present (1) or absent (0)");
    const updated = await tx.execute<{ id: string }>(
      sql`
      update stock_count_lines set counted_quantity = ${counted}, first_counted_quantity=${counted}, first_counted_by=${actorId},
        second_counted_quantity=null,second_counted_by=null,second_counted_at=null, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${line.id}
      returning id`,
      "objects",
    );
    if (updated.length === 0) {
      throw new InventoryError(
        "count line changed while this action was in flight — reload the count and try again",
      );
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
    return {
      lineId: line.id,
      variance: count.blind ? null : add(counted, neg(line.expected_quantity)),
    };
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
): Promise<{ lineId: string; expectedQuantity: string | null }> {
  return db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, input.countId, true);
    if (count.status !== "counting") {
      throw new InventoryError(
        `cannot recount while the count is ${count.status} — send the count back to counting first`,
      );
    }
    const line = (
      await tx.execute<{
        id: string;
        item_id: string;
        stock_location_id: string;
        lot_id: string | null;
        serial_id: string | null;
        expected_quantity: string;
        counted_quantity: string | null;
        adjustment_movement_id: string | null;
      }>(
        sql`
      select id, item_id, stock_location_id, lot_id, serial_id, expected_quantity::text, counted_quantity::text,
             adjustment_movement_id
        from stock_count_lines
       where org_id = ${orgId} and id = ${input.lineId} and stock_count_id = ${count.id}
       for update`,
        "objects",
      )
    )[0];
    if (!line) {
      throw new InventoryError(
        "count line not found on this count — reload the count and try again",
      );
    }
    if (line.adjustment_movement_id) {
      throw new InventoryError(
        "line already posted an inventory adjustment — correct it with a new count, not an edit",
      );
    }
    const basis = await getOnHandWith(tx, orgId, line.item_id, line.stock_location_id, {
      lotId: line.lot_id,
      serialId: line.serial_id,
      subsidiaryId: count.subsidiaryId,
    });
    const updated = await tx.execute<{ id: string }>(
      sql`
      update stock_count_lines
         set expected_quantity = ${basis.quantity}, counted_quantity = null,
             first_counted_quantity=null,first_counted_by=null,second_counted_quantity=null,second_counted_by=null,second_counted_at=null,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${line.id}
      returning id`,
      "objects",
    );
    if (updated.length === 0) {
      throw new InventoryError(
        "count line changed while this action was in flight — reload the count and try again",
      );
    }
    // A recount clears the prior observation: the discarded before-image
    // commits its audit row atomically with the clear, and survives posting.
    await auditCountedChange(tx, orgId, actorId, {
      lineId: line.id,
      countId: count.id,
      operation: "recount",
      reason: countedChangeReason(
        input.reason,
        "recount: re-snapshotted the baseline, prior observation cleared",
      ),
      before: { countedQuantity: line.counted_quantity, expectedQuantity: line.expected_quantity },
      after: { countedQuantity: null, expectedQuantity: basis.quantity },
    });
    return { lineId: line.id, expectedQuantity: count.blind ? null : basis.quantity };
  });
}

export async function submitStockCountForReview(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "stock_count", countId);
    const tx = db;
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, countId, true);
    if (count.status !== "counting") {
      assertCountTransition(count.status, "review");
    }
    const submitLines = await requireAllLinesCounted(tx, orgId, count.id);
    await assertSecondCounts(tx, orgId, count.id);
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
    if (!actorId) throw new InventoryError("A named operator must submit this count.");
    await lockActorCommandAuthority(tx, orgId, actorId, count.subsidiaryId, "items.post");
    const marked = await tx.execute(
      sql`update stock_counts set submitted_by=${actorId}
      where org_id=${orgId} and id=${count.id} and status='counting' returning id`,
      "objects",
    );
    if (marked.length !== 1) throw new InventoryError("The count changed during submission.");
    const policy = await routeStockCount(orgId, actorId, count.id);
    const submitted = await tx.execute(
      sql`update stock_counts set status='review',submission_policy=${JSON.stringify(policy)}::jsonb,
      review_released=${policy.kind === "ungated"},updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${count.id} and status='counting' returning id`,
      "objects",
    );
    if (submitted.length !== 1) throw new InventoryError("The count changed during submission.");
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes)
      values(${orgId},'stock_counts',${count.id},'submit',${actorId},${JSON.stringify({ policy })}::jsonb)`);
    return { id: count.id, status: "review" as StockCountStatus };
  });
}

export async function returnStockCountToCounting(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "stock_count", countId);
    const tx = db;
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, countId, true);
    await cancelStockCountRouting(orgId, actorId, countId);
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
    if (count.status === "review")
      throw new InventoryError(
        "Return the count to counting before changing its date, then resubmit it through Flows.",
      );
    await assertPeriodCovers(tx, orgId, input.countedOn);
    const updated = await tx.execute<{ id: string }>(
      sql`
      update stock_counts set counted_on = ${input.countedOn}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${count.id}
      returning id`,
      "objects",
    );
    if (updated.length === 0) {
      throw new InventoryError(
        "stock count changed while this action was in flight — reload the count and try again",
      );
    }
    return { id: count.id, countedOn: input.countedOn };
  });
}

export async function cancelStockCount(
  orgId: string,
  actorId: string | null,
  countId: string,
): Promise<{ id: string; status: StockCountStatus }> {
  return withOrgTransaction(orgId, async () => {
    const tx = db;
    await assertInventoryFeature(tx, orgId);
    const count = await loadCountHeader(tx, orgId, countId, true);
    const postedLines = await tx.execute<{ n: string }>(
      sql`
      select count(*)::text as n from stock_count_lines
       where org_id = ${orgId} and stock_count_id = ${count.id} and adjustment_movement_id is not null`,
      "objects",
    );
    if (postedLines[0]?.n !== "0") {
      throw new InventoryError(
        "cannot cancel a count that already posted adjustments — correct with a new count",
      );
    }
    await cancelStockCountRouting(orgId, actorId, countId);
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
  options: {
    /**
     * Unit cost per count line id for found (positive-variance) quantities.
     * Required for an item with nothing valued on hand to average; when
     * given it prices the found units instead of the on-hand average.
     */
    foundUnitCosts?: Record<string, string>;
  } = {},
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
    // Canonical lock order: fence every line position before the
    // transaction takes any row lock, or a peer holding the fence deadlocks
    // against this transaction at posting. The lines are fixed once the
    // count reaches review; the re-read below revalidates them under fence.
    const subjects = await tx.execute<{ item_id: string; stock_location_id: string }>(
      sql`
      select item_id, stock_location_id from stock_count_lines
       where org_id = ${orgId} and stock_count_id = ${countId}`,
      "objects",
    );
    for (const key of [
      ...new Set(subjects.map((line) => `${line.item_id}:${line.stock_location_id}`)),
    ].sort()) {
      const separator = key.indexOf(":");
      await lockInventoryPosition(tx, key.slice(0, separator), key.slice(separator + 1));
    }
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
    const review = (
      await tx.execute<{
        review_released: boolean;
        submission_policy: unknown;
      }>(
        sql`
      select review_released,submission_policy from stock_counts where org_id=${orgId} and id=${count.id}`,
        "objects",
      )
    )[0];
    if (!review?.review_released || !review.submission_policy)
      throw new InventoryError(
        "Complete the count's Flow approvals before posting. If it has not been submitted, return it to counting and submit it for review.",
      );
    if (!actorId) throw new InventoryError("A named inventory operator must post the count.");
    await lockActorCommandAuthority(tx, orgId, actorId, count.subsidiaryId, "items.post");
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
    await assertSecondCounts(tx, orgId, count.id);
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
    // key, so lot and serial count lines share the fenced item/location.
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
      const live = await getOnHandWith(tx, orgId, line.itemId, line.stockLocationId, {
        lotId: line.lotId,
        serialId: line.serialId,
        subsidiaryId: count.subsidiaryId,
      });
      if (cmp(live.quantity, line.expectedQuantity) !== 0) {
        drifted.push({ line, live: live.quantity });
      }
    }
    if (drifted.length > 0) {
      const first = drifted[0]!;
      const detail = (
        await tx.execute<{ code: string | null; loc: string | null }>(
          sql`
        select (select code from items where org_id = ${orgId} and id = ${first.line.itemId}) as code,
               (select code from stock_locations where org_id = ${orgId} and id = ${first.line.stockLocationId}) as loc`,
          "objects",
        )
      )[0];
      const where = `item ${detail?.code ?? first.line.itemId} at ${detail?.loc ?? first.line.stockLocationId}`;
      throw new InventoryError(
        drifted.length === 1
          ? `cannot post: expected quantity drifted for ${where} (snapshot ${first.line.expectedQuantity}, on hand now ${first.live}) — send the count back to counting, recount the line, and re-submit`
          : `cannot post: expected quantity drifted for ${drifted.length} lines (first: ${where}, snapshot ${first.line.expectedQuantity}, on hand now ${first.live}) — send the count back to counting, recount the drifted lines, and re-submit`,
      );
    }
    return { count, lines, policy: review.submission_policy };
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
      results.push({
        lineId: line.id,
        variance,
        movementId: line.adjustmentMovementId,
        entryId: null,
      });
      continue;
    }
    let movementId: string;
    let entryId: string | null;
    const foundUnitCost = cmp(variance, "0") > 0 ? options.foundUnitCosts?.[line.id] : undefined;
    try {
      const posted = await adjustInventory(orgId, actorId, {
        itemId: line.itemId,
        stockLocationId: line.stockLocationId,
        quantityDelta: variance,
        unitCost: foundUnitCost,
        subsidiaryId: prepared.count.subsidiaryId,
        date: prepared.count.countedOn,
        lotId: line.lotId,
        serialId: line.serialId,
        memo: `Stock count ${prepared.count.id}`,
        locationId: prepared.count.locationId,
        admission: "count",
        stockCountLineId: line.id,
      });
      movementId = posted.movementId;
      entryId = posted.entryId;
    } catch (error) {
      if (error instanceof InventoryCostBasisError) {
        throw new InventoryError(
          `cannot post: the count found ${variance} of item ${error.itemLabel}, which has no cost basis at this stock location — enter the unit cost of the found quantity on that count line and post again (nothing posted: the whole post rolls back together)`,
        );
      }
      if (error instanceof InventoryError && /closed/i.test(error.message)) {
        throw new InventoryError(
          `count date ${prepared.count.countedOn} falls in a closed period — reopen the period, or move the count date to an open period and post again (nothing posted: the whole post rolls back together)`,
        );
      }
      throw error;
    }
    const stamped = await db.execute<{ id: string }>(
      sql`
      update stock_count_lines set adjustment_movement_id = ${movementId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${line.id}
         and (adjustment_movement_id is null or adjustment_movement_id = ${movementId})
      returning id`,
      "objects",
    );
    if (stamped.length === 0) {
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
  const flipped = await db.execute<{ id: string }>(
    sql`
    update stock_counts
       set status = 'posted', posted_entry_id = coalesce(${firstEntryId}, posted_entry_id),
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${prepared.count.id} and status = 'review'
    returning id`,
    "objects",
  );
  if (flipped.length === 0) {
    throw new InventoryError(
      "stock count left review while this post was in flight — reload the count; lines already stamped keep their adjustments and are skipped on retry",
    );
  }
  // Review evidence either way, in the same atomic unit: who posted, who
  // contributed, and the total variance — or the explicit note that no
  // independent review happened.
  const totalVariance = results.reduce((sum, line) => add(sum, line.variance), "0");
  const reviewed = await db.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'stock_counts', ${prepared.count.id}, 'update',
            ${JSON.stringify({
              operation: "post",
              review: {
                policy: prepared.policy,
                postedBy: actorId,
                totalVariance,
                lineCount: results.length,
              },
            })}::jsonb,
            ${actorId})
    returning id`,
    "objects",
  );
  if (reviewed.length === 0) {
    throw new InventoryError("stock count post was not audited — reload the count and try again");
  }
  return { id: prepared.count.id, status: "posted", lines: results };
}
