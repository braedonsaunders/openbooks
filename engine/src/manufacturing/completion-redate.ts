import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { neg } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { addLayerAtCost } from "../inventory/cost-layers.ts";
import { createReceiptInspection } from "../inventory/inspections.ts";
import { InventoryError, type Runner } from "../inventory/contracts.ts";
import type { JournalLineInput } from "../inventory/journal.ts";
import {
  inventoryPeriodClosure,
  lockInventoryPosition,
  periodForDate,
  subsidiaryCurrency,
} from "../inventory/position.ts";
import { resolveProfile } from "../inventory/profile-policy.ts";
import {
  removeInboundLayer,
  reverseInventoryJournal,
  type ReversibleMovement,
} from "../inventory/reversal.ts";
import { lockManufacturingOrderManageAuthority } from "./authority.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { postManufacturingEntry } from "./journal.ts";
import { auditChange } from "./master-support.ts";

// ---------------------------------------------------------------------------
// Completion date correction
//
// A completed work order's finished-goods receipts carry the day production
// finished. When that day was recorded wrongly, the receipts are corrected by
// appending, never by editing history: each completion's journal and receipt
// layers are reversed on the completion's own date, and an identical journal
// and receipt are posted on the corrected date. Quantities, unit costs, values,
// accounts and dimensions are unchanged, so only the date moves.
// ---------------------------------------------------------------------------

export interface CompletionDateCorrectionInput {
  /** Business day production finished; must be earlier than the recorded receipt day. */
  correctedOn: string;
  reason: string;
}

export interface CompletionDateCorrectionResult {
  workOrderId: string;
  correctedOn: string;
  /** True when an earlier identical correction already applied and nothing changed. */
  replayed: boolean;
  /** Live re-posted completion entries that carry the corrected dates. */
  redatedEntryIds: string[];
  corrections: Array<{
    originalEntryId: string;
    originalEntryNumber: string;
    originalDate: string;
    reversalEntryId: string | null;
    redatedEntryId: string | null;
    movementIds: string[];
  }>;
}

const REASON_MIN_LENGTH = 5;
const REASON_MAX_LENGTH = 500;
const CONFLICT_LIMIT = 5;
/** Custom evidence this correction rewrites on the re-posted journal. */
const CORRECTION_EVIDENCE_KEYS = new Set([
  "work_order_number",
  "bom_revision",
  "routing_version",
  "completion_redate_key",
  "completion_redate_reason",
  "completion_redate_reversal_entry_id",
  "redated_from_entry_id",
  "redated_from_entry_number",
  "redated_from_date",
]);

function refuse(message: string, code: string, remedy: string, status = 422): never {
  throw new ManufacturingError(message, { status, code, remedy });
}

/** Trimmed reason; corrections must say why the recorded day was wrong. */
export function normalizeCompletionCorrectionReason(value: string): string {
  const reason = (value ?? "").trim();
  if (reason.length < REASON_MIN_LENGTH || reason.length > REASON_MAX_LENGTH) {
    refuse(
      `Correcting a completion date requires a reason between ${REASON_MIN_LENGTH} and ${REASON_MAX_LENGTH} characters.`,
      "completion_correction_reason_required",
      "Enter why the recorded receipt date is wrong.",
    );
  }
  return reason;
}

/**
 * Stable identity of one correction request. Replays of the same work order,
 * corrected day and reason resolve to the same key, so a retry returns the
 * applied result instead of posting a second correction.
 */
export function completionCorrectionKey(
  orgId: string,
  workOrderId: string,
  correctedOn: string,
  reason: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "completion-date-correction",
        1,
        orgId,
        workOrderId,
        correctedOn,
        reason.trim(),
      ]),
    )
    .digest("hex");
}

/** Latest of the present ISO dates (lexical order is calendar order for YYYY-MM-DD). */
export function latestDate(values: ReadonlyArray<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value && (latest === null || value > latest)) latest = value;
  }
  return latest;
}

/** A corrected day must be a real calendar day that has already happened. */
export function assertCorrectionDay(correctedOn: string, today: string): void {
  if (!isIsoCalendarDate(correctedOn)) {
    refuse(
      `Corrected date ${correctedOn} is not a calendar date.`,
      "invalid_completion_correction_date",
      "Enter the date as YYYY-MM-DD.",
    );
  }
  if (correctedOn > today) {
    refuse(
      `Completion cannot be dated after today (${today}).`,
      "completion_date_in_future",
      "Enter the day production actually finished.",
    );
  }
}

/**
 * Date rules for a correction, independent of the database. The floor is the
 * latest day the order's operations and recorded material or conversion
 * postings reached: a completion cannot precede the work that produced it.
 * The earliest current receipt bounds the move: corrections only move earlier.
 */
export function assertCorrectedCompletionDate(input: {
  correctedOn: string;
  today: string;
  floor: string | null;
  earliestReceiptDate: string;
}): void {
  assertCorrectionDay(input.correctedOn, input.today);
  if (input.floor !== null && input.correctedOn < input.floor) {
    refuse(
      `Completion cannot be dated before ${input.floor}, when its operations and recorded materials were posted.`,
      "completion_date_before_floor",
      `Use ${input.floor} or a later date.`,
    );
  }
  if (input.correctedOn > input.earliestReceiptDate) {
    refuse(
      `The completion is already dated ${input.earliestReceiptDate}; a correction can only move it earlier.`,
      "completion_date_not_earlier",
      `Enter a day before ${input.earliestReceiptDate}.`,
    );
  }
}

type CompletionEntry = {
  id: string;
  entry_number: string;
  posting_date: string;
  book_id: string;
  subsidiary_id: string;
  custom: Record<string, unknown>;
};

type Receipt = ReversibleMovement & { moved_date: string; serial_number: string | null };

type OrderRow = {
  id: string;
  number: string;
  status: string;
  subsidiary_id: string | null;
  started_on: string | null;
};

async function loadOrder(tx: SqlExecutor, orgId: string, workOrderId: string): Promise<OrderRow> {
  const row = (
    await tx.execute<OrderRow>(
      sql`
    select id, number, status, subsidiary_id, started_at::date::text as started_on
      from mfg_work_orders where org_id=${orgId} and id=${workOrderId} for update`,
      "objects",
    )
  )[0];
  if (!row) throw new ManufacturingNotFoundError();
  return row;
}

/** Live completion entries (posted, not reversed) with their completion evidence. */
async function liveCompletionEntries(
  tx: SqlExecutor,
  orgId: string,
  workOrderNumber: string,
): Promise<CompletionEntry[]> {
  return await tx.execute<CompletionEntry>(
    sql`
    select id, entry_number, posting_date::text as posting_date, book_id, subsidiary_id, custom
      from journal_entries
     where org_id=${orgId} and origin='manufacturing' and custom->>'work_order_number'=${workOrderNumber}
       and custom ? 'completion_quantity' and status='posted' and reverses_entry_id is null -- Live entries only: only current postings constrain or authorize completion correction.
     order by posting_date, created_at, id`,
    "objects",
  );
}

function idList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`,`,
  );
}

/** Live finished-goods receipts produced by the given completion entries. */
async function loadReceipts(
  tx: SqlExecutor,
  orgId: string,
  entryIds: string[],
  lock = false,
): Promise<Receipt[]> {
  if (entryIds.length === 0) return [];
  return await tx.execute<Receipt>(
    sql`
    select movement.id, movement.org_id, movement.subsidiary_id, movement.item_id, movement.kind,
           movement.moved_at::text as moved_at, movement.moved_at::date::text as moved_date,
           movement.stock_location_id, movement.lot_id, movement.serial_id, serial.serial_number,
           movement.quantity::text as quantity, movement.unit_cost::text as unit_cost,
           movement.total_value::text as total_value, movement.journal_entry_id,
           movement.paired_movement_id, movement.status
      from inventory_movements movement left join serials serial
        on serial.org_id=movement.org_id and serial.id=movement.serial_id
     where movement.org_id=${orgId} and movement.journal_entry_id in (${idList(entryIds)})
       and movement.kind='assembly_build' and movement.status='posted' and movement.reverses_movement_id is null
       and not exists (select 1 from inventory_movements reversal
             where reversal.org_id=movement.org_id and reversal.reverses_movement_id=movement.id and reversal.status='posted')
     order by movement.moved_at, movement.created_at, movement.id
     ${lock ? sql`for update of movement` : sql``}`,
    "objects",
  );
}

/** Work that must precede the completion: operation days and non-completion postings. */
async function correctionFloor(
  tx: SqlExecutor,
  orgId: string,
  order: OrderRow,
  workOrderId: string,
): Promise<string | null> {
  const row = (
    await tx.execute<{ last_operation: string | null; posting_floor: string | null }>(
      sql`
    select (select max(completed_at)::date::text from mfg_wo_operations
             where org_id=${orgId} and work_order_id=${workOrderId} and status='done') as last_operation,
           (select max(posting_date)::text from journal_entries
             where org_id=${orgId} and origin='manufacturing' and custom->>'work_order_number'=${order.number}
               and status='posted' and reverses_entry_id is null -- Live entries only: only current postings constrain or authorize completion correction.
               -- Completions are the dates being corrected; a short-close variance is period-end WIP, not production.
               and not (custom ? 'completion_quantity') and not (custom ? 'shortCloseReason')) as posting_floor`,
      "objects",
    )
  )[0];
  return latestDate([row?.last_operation ?? null, order.started_on, row?.posting_floor ?? null]);
}

async function correctionReplay(
  tx: SqlExecutor,
  orgId: string,
  key: string,
): Promise<Array<{ id: string; entry_number: string }>> {
  return await tx.execute<{ id: string; entry_number: string }>(
    sql`
    select id, entry_number from journal_entries
     where org_id=${orgId} and origin='manufacturing' and custom->>'completion_redate_key'=${key}
       and status='posted' and reverses_entry_id is null -- Live entries only: only current postings constrain or authorize completion correction.
     order by created_at, id`,
    "objects",
  );
}

function describeMovement(row: {
  entry_number: string | null;
  kind: string;
  moved_date: string;
  quantity: string;
}): string {
  return `${row.entry_number ?? "inventory movement"} (${row.kind}, ${row.moved_date}, ${row.quantity})`;
}

/**
 * Re-date a completed work order's finished-goods receipts to `correctedOn`.
 * Refusals name the blocking evidence and state the remedy. The whole
 * correction is one transaction: it either re-dates every completion of the
 * order or none of them.
 */
export async function correctWorkOrderCompletionDate(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  workOrderId: string,
  input: CompletionDateCorrectionInput,
): Promise<CompletionDateCorrectionResult> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingOrderManageAuthority(tx, orgId, actorId, workOrderId);
  const reason = normalizeCompletionCorrectionReason(input.reason);
  const correctedOn = input.correctedOn;
  const order = await loadOrder(tx, orgId, workOrderId);
  if (order.status !== "done" && order.status !== "closed") {
    refuse(
      `Work order ${order.number} is ${order.status}; only a completed work order's receipt date can be corrected this way.`,
      "completion_date_order_not_done",
      "Reverse the completion receipt while the order is open, then receive it again on the correct date.",
      409,
    );
  }
  assertCorrectionDay(correctedOn, await businessToday(orgId));
  const key = completionCorrectionKey(orgId, workOrderId, correctedOn, reason);

  const entries = await liveCompletionEntries(tx, orgId, order.number);
  if (entries.length === 0) {
    refuse(
      `Work order ${order.number} has no live completion receipt.`,
      "completion_date_no_receipt",
      "Record the finished-goods receipt before correcting its date.",
      409,
    );
  }
  // Canonical lock order: fence each position before locking its receipt rows.
  const peeked = await loadReceipts(
    tx,
    orgId,
    entries.map((entry) => entry.id),
  );
  if (peeked.length === 0) {
    refuse(
      `Work order ${order.number}'s completion has no receipt movements.`,
      "completion_date_no_receipt",
      "Review the completion's inventory movements.",
      409,
    );
  }
  const positions = [
    ...new Set(peeked.map((row) => row.item_id + ":" + row.stock_location_id)),
  ].sort();
  for (const position of positions) {
    const split = position.indexOf(":");
    await lockInventoryPosition(tx as Runner, position.slice(0, split), position.slice(split + 1));
  }
  const receipts = await loadReceipts(
    tx,
    orgId,
    entries.map((entry) => entry.id),
    true,
  );
  if (receipts.map((row) => row.id).join() !== peeked.map((row) => row.id).join()) {
    refuse(
      `Work order ${order.number}'s receipts changed while the correction was prepared.`,
      "completion_changed",
      "Reload the work order and retry.",
      409,
    );
  }

  const movers = receipts.filter((row) => row.moved_date > correctedOn);
  if (movers.length === 0) {
    const applied = await correctionReplay(tx, orgId, key);
    if (applied.length > 0) {
      // The earlier application already holds the corrected dates; nothing is written again.
      return {
        workOrderId,
        correctedOn,
        replayed: true,
        redatedEntryIds: applied.map((entry) => entry.id),
        corrections: [],
      };
    }
    refuse(
      `Completion receipts of work order ${order.number} are already dated ${correctedOn} or earlier.`,
      "completion_date_unchanged",
      "No correction is needed for this date.",
      409,
    );
  }

  const earliest = receipts.map((row) => row.moved_date).sort()[0]!;
  const floor = await correctionFloor(tx, orgId, order, workOrderId);
  assertCorrectedCompletionDate({
    correctedOn,
    today: await businessToday(orgId),
    floor,
    earliestReceiptDate: earliest,
  });

  const moverIds = movers.map((row) => row.id);
  const receiptIds = receipts.map((row) => row.id);
  const moverEntries = entries.filter((entry) =>
    movers.some((row) => row.journal_entry_id === entry.id),
  );

  // Recorded inspection decisions stay bound to the receipt; pending holds
  // are copied with their frozen policy when the receipt is replaced.
  const inspected = (
    await tx.execute<{ id: string }>(
      sql`
    select id from inventory_inspections where org_id=${orgId} and receipt_movement_id in (${idList(moverIds)})
      and status <> 'pending' limit 1`,
      "objects",
    )
  )[0];
  if (inspected) {
    refuse(
      `A receipt of work order ${order.number} has a recorded quality inspection decision, which stays bound to the original receipt.`,
      "completion_receipt_inspected",
      "This completion cannot be re-dated while its inspection decision is recorded against it; record a governed inventory adjustment for the stock instead.",
      409,
    );
  }
  const custody = (
    await tx.execute<{ id: string }>(
      sql`
    select id from consignment_events where org_id=${orgId} and receipt_movement_id in (${idList(moverIds)}) limit 1`,
      "objects",
    )
  )[0];
  if (custody) {
    refuse(
      `A receipt of work order ${order.number} has custody evidence, so its external stock cannot be restored by a date correction.`,
      "completion_receipt_custody",
      "Use an adjusting inventory transaction for this stock.",
      409,
    );
  }

  // Stock from these receipts may not have been drawn by any live movement.
  const consumers = await tx.execute<{
    kind: string;
    moved_date: string;
    quantity: string;
    entry_number: string | null;
  }>(
    sql`
    select issue.kind, issue.moved_at::date::text as moved_date, (-issue.quantity)::text as quantity, entry.entry_number
      from cost_layer_consumptions consumption
      join cost_layers layer on layer.org_id=consumption.org_id and layer.id=consumption.cost_layer_id
      join inventory_movements issue on issue.org_id=consumption.org_id and issue.id=consumption.issue_movement_id
      left join journal_entries entry on entry.org_id=issue.org_id and entry.id=issue.journal_entry_id
     where consumption.org_id=${orgId} and layer.source_movement_id in (${idList(moverIds)})
       and not exists (select 1 from inventory_movements reversal
             where reversal.org_id=issue.org_id and reversal.reverses_movement_id=issue.id and reversal.status='posted')
     order by issue.moved_at, issue.id limit ${CONFLICT_LIMIT}`,
    "objects",
  );
  if (consumers.length) {
    refuse(
      `Stock from work order ${order.number}'s receipt has been consumed by ${consumers.map(describeMovement).join("; ")}.`,
      "completion_receipt_consumed",
      "Reverse or re-date the consuming movements first, then retry the correction.",
      409,
    );
  }

  for (const row of movers) {
    if (!row.serial_id) continue;
    const serial = (
      await tx.execute<{ status: string; current_stock_location_id: string | null }>(
        sql`
      select status, current_stock_location_id from serials where org_id=${orgId} and id=${row.serial_id}`,
        "objects",
      )
    )[0];
    if (
      !serial ||
      serial.status !== "in_stock" ||
      serial.current_stock_location_id !== row.stock_location_id
    ) {
      refuse(
        `Serial ${row.serial_number ?? "evidence"} has moved since its receipt, so its receipt cannot be re-dated.`,
        "completion_serial_moved",
        "Reverse the serial's later movements first, then retry the correction.",
        409,
      );
    }
  }

  // Valuation: moving a receipt earlier changes the cost basis of any other
  // movement of the same item, location and legal entity dated between the
  // corrected day and the original day, because layers are consumed in date
  // order. Such movements make the correction refuse; receipts of this order
  // are excluded because they keep their relative order.
  const groups = new Map<
    string,
    { item: string; location: string; subsidiary: string; latest: string }
  >();
  for (const row of movers) {
    const groupKey = [row.item_id, row.stock_location_id, row.subsidiary_id].join("|");
    const current = groups.get(groupKey);
    if (!current || row.moved_date > current.latest) {
      groups.set(groupKey, {
        item: row.item_id,
        location: row.stock_location_id,
        subsidiary: row.subsidiary_id,
        latest: row.moved_date,
      });
    }
  }
  const conflicts: Array<{
    entry_number: string | null;
    kind: string;
    moved_date: string;
    quantity: string;
  }> = [];
  for (const group of groups.values()) {
    const rows = await tx.execute<{
      entry_number: string | null;
      kind: string;
      moved_date: string;
      quantity: string;
    }>(
      sql`
      select entry.entry_number, movement.kind, movement.moved_at::date::text as moved_date, movement.quantity::text as quantity
        from inventory_movements movement left join journal_entries entry
          on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
       where movement.org_id=${orgId} and movement.item_id=${group.item} and movement.stock_location_id=${group.location}
         and movement.subsidiary_id=${group.subsidiary} and movement.status='posted'
         and movement.moved_at::date >= ${correctedOn}::date and movement.moved_at::date <= ${group.latest}::date
         and movement.id not in (${idList(receiptIds)})
       order by movement.moved_at, movement.created_at, movement.id limit ${CONFLICT_LIMIT}`,
      "objects",
    );
    conflicts.push(...rows);
  }
  if (conflicts.length) {
    const latestConflict = latestDate(conflicts.map((row) => row.moved_date))!;
    refuse(
      `Moving work order ${order.number}'s receipt to ${correctedOn} would change the cost of ${conflicts.map(describeMovement).join("; ")}.`,
      "completion_date_valuation_conflict",
      `Choose a date after ${latestConflict}, or reverse those movements first.`,
      409,
    );
  }

  // Each reversal lands on its completion's original day, so the original
  // period must accept it. The re-post lands on the corrected day.
  for (const entry of moverEntries) {
    const periodId = await periodForDate(orgId, entry.posting_date, tx as Runner);
    if (!periodId)
      refuse(
        `No accounting period covers ${entry.posting_date}.`,
        "posting_period_missing",
        "Open an accounting period for the original completion date.",
        409,
      );
    const closed = await inventoryPeriodClosure(tx as Runner, orgId, periodId, entry.book_id, [
      entry.subsidiary_id,
    ]);
    if (closed)
      refuse(
        closed,
        "completion_date_period_closed",
        `Reopen the period covering ${entry.posting_date} through Close, then retry.`,
        409,
      );
  }
  for (const entry of moverEntries) {
    const periodId = await periodForDate(orgId, correctedOn, tx as Runner);
    if (!periodId)
      refuse(
        `No accounting period covers ${correctedOn}.`,
        "posting_period_missing",
        "Open an accounting period for the corrected date.",
        409,
      );
    const closed = await inventoryPeriodClosure(tx as Runner, orgId, periodId, entry.book_id, [
      entry.subsidiary_id,
    ]);
    if (closed)
      refuse(
        closed,
        "completion_date_period_closed",
        `Reopen the period covering ${correctedOn} through Close, then retry.`,
        409,
      );
  }

  const corrections: CompletionDateCorrectionResult["corrections"] = [];
  try {
    for (const entry of moverEntries) {
      corrections.push(
        await redateCompletionEntry(
          tx,
          orgId,
          actorId,
          order,
          entry,
          movers.filter((row) => row.journal_entry_id === entry.id),
          { correctedOn, reason, key },
        ),
      );
    }
  } catch (error) {
    // Inventory refusals keep their cause; they become refusals the operator can act on.
    if (error instanceof InventoryError) {
      refuse(
        error.message,
        "completion_date_inventory_refused",
        "Resolve the blocking inventory activity named above, then retry the correction.",
        409,
      );
    }
    throw error;
  }

  await auditChange(tx, {
    orgId,
    actorId,
    table: "mfg_work_orders",
    rowId: order.id,
    action: "update",
    before: {
      completionDates: moverEntries.map((entry) => ({
        entryId: entry.id,
        entryNumber: entry.entry_number,
        date: entry.posting_date,
      })),
    },
    after: {
      completionDates: corrections.map((correction) => ({
        entryId: correction.redatedEntryId,
        date: correctedOn,
      })),
      correctedOn,
      correctionKey: key,
      reversedEntries: corrections.map((correction) => correction.reversalEntryId),
      repostedEntries: corrections.map((correction) => correction.redatedEntryId),
      reason,
    },
  });
  return {
    workOrderId,
    correctedOn,
    replayed: false,
    redatedEntryIds: corrections.map((correction) => correction.redatedEntryId!),
    corrections,
  };
}

/** Reverse one completion's receipts and journal on their original day, then re-post them on the corrected day. */
async function redateCompletionEntry(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  order: OrderRow,
  entry: CompletionEntry,
  movers: Receipt[],
  correction: { correctedOn: string; reason: string; key: string },
): Promise<CompletionDateCorrectionResult["corrections"][number]> {
  const lineRows = await tx.execute<{
    account_id: string;
    amount: string;
    location_id: string | null;
    department_id: string | null;
    project_id: string | null;
    memo: string | null;
  }>(
    sql`
    select account_id, amount::text as amount, location_id, department_id, project_id, memo
      from journal_lines where org_id=${orgId} and entry_id=${entry.id} order by line_number`,
    "objects",
  );
  const lines: JournalLineInput[] = lineRows.map((row) => ({
    accountId: row.account_id,
    amount: row.amount,
    locationId: row.location_id,
    departmentId: row.department_id,
    projectId: row.project_id,
    memo: row.memo,
  }));
  const signature = (rows: JournalLineInput[]) =>
    rows
      .map((line) =>
        [
          line.accountId,
          line.amount,
          line.locationId ?? "",
          line.departmentId ?? "",
          line.projectId ?? "",
          line.memo ?? "",
        ].join("|"),
      )
      .sort();

  for (const row of movers) {
    await removeInboundLayer(tx as Runner, orgId, row, actorId);
  }
  const reversalEntryId = await reverseInventoryJournal(
    tx as Runner,
    orgId,
    actorId,
    entry.id,
    entry.posting_date,
    correction.reason,
    { allowManufacturingOrigin: true },
  );

  const movementIds: string[] = [];
  for (const row of movers) {
    const reversal = (
      await tx.execute<{ id: string }>(
        sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
         quantity, unit_cost, total_value, journal_entry_id, reverses_movement_id, reversal_reason,
         status, memo, created_by, updated_by)
      values (${orgId}, ${row.subsidiary_id}, ${row.item_id}, 'return', ${entry.posting_date},
        ${row.stock_location_id}, ${row.lot_id}, ${row.serial_id}, ${neg(row.quantity)},
        ${row.unit_cost}, ${row.total_value === null ? null : neg(row.total_value)},
        ${reversalEntryId}, ${row.id}, ${correction.reason}, 'posted',
        ${"Reversal of work order " + order.number + " completion for date correction: " + correction.reason},
        ${actorId}, ${actorId}) returning id`,
        "objects",
      )
    )[0];
    if (!reversal) throw new InventoryError("The completion receipt reversal was not recorded.");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'inventory_movements', ${row.id}, 'void',
        ${JSON.stringify({ reason: correction.reason, reversalDate: entry.posting_date, reversalMovementId: reversal.id, reversalEntryId })}::jsonb,
        ${actorId})`);
    if (row.serial_id) {
      const serial = await tx.execute<{ id: string }>(
        sql`
        update serials set status='registered', current_stock_location_id=null, updated_at=now(), updated_by=${actorId}
         where org_id=${orgId} and id=${row.serial_id} and status='in_stock' and current_stock_location_id=${row.stock_location_id}
         returning id`,
        "objects",
      );
      if (serial.length !== 1)
        throw new InventoryError(
          "Serial " +
            (row.serial_number ?? "evidence") +
            " changed before the completion date correction.",
        );
    }
  }

  const bookId = entry.book_id;
  const currency = await subsidiaryCurrency(orgId, entry.subsidiary_id, tx as Runner);
  const periodId = await periodForDate(orgId, correction.correctedOn, tx as Runner);
  if (!periodId) throw new InventoryError(`No accounting period covers ${correction.correctedOn}.`);
  const evidence: Record<string, unknown> = Object.fromEntries(
    Object.entries(entry.custom).filter(([name]) => !CORRECTION_EVIDENCE_KEYS.has(name)),
  );
  const redatedEntryId = await postManufacturingEntry(tx as Runner, {
    orgId,
    bookId,
    subsidiaryId: entry.subsidiary_id,
    actorId,
    currency,
    periodId,
    date: correction.correctedOn,
    entryNumber: "MFG-COMP-" + correction.correctedOn + "-" + randomUUID().slice(0, 12),
    memo:
      "Finished goods completion for work order " +
      order.number +
      ", dated " +
      correction.correctedOn +
      " (re-dated from " +
      entry.posting_date +
      ")",
    lines,
    custom: {
      ...evidence,
      workOrderNumber: String(entry.custom.work_order_number ?? ""),
      bomRevision: String(entry.custom.bom_revision ?? ""),
      routingVersion: String(entry.custom.routing_version ?? ""),
      completion_redate_key: correction.key,
      completion_redate_reason: correction.reason,
      completion_redate_reversal_entry_id: reversalEntryId,
      redated_from_entry_id: entry.id,
      redated_from_entry_number: entry.entry_number,
      redated_from_date: entry.posting_date,
    },
  });

  const reposted = await tx.execute<{
    account_id: string;
    amount: string;
    location_id: string | null;
    department_id: string | null;
    project_id: string | null;
    memo: string | null;
  }>(
    sql`
    select account_id, amount::text as amount, location_id, department_id, project_id, memo
      from journal_lines where org_id=${orgId} and entry_id=${redatedEntryId} order by line_number`,
    "objects",
  );
  const repostedLines: JournalLineInput[] = reposted.map((row) => ({
    accountId: row.account_id,
    amount: row.amount,
    locationId: row.location_id,
    departmentId: row.department_id,
    projectId: row.project_id,
    memo: row.memo,
  }));
  if (signature(repostedLines).join("\n") !== signature(lines).join("\n")) {
    throw new InventoryError("The re-posted completion journal does not match the original lines.");
  }

  for (const row of movers) {
    const method = (await resolveProfile(orgId, row.item_id, tx as Runner, true)).costingMethod;
    const inserted = await tx.execute<{ id: string }>(
      sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
         quantity, unit_cost, total_value, journal_entry_id, status, memo, idempotency_key, created_by, updated_by)
      values (${orgId}, ${row.subsidiary_id}, ${row.item_id}, 'assembly_build', ${correction.correctedOn},
        ${row.stock_location_id}, ${row.lot_id}, ${row.serial_id}, ${row.quantity}, ${row.unit_cost},
        ${row.total_value}, ${redatedEntryId}, 'posted',
        ${"Work order " + order.number + " completion re-dated from " + entry.posting_date + " to " + correction.correctedOn},
        ${"mfg-completion-redate:" + correction.key + ":" + row.id}, ${actorId}, ${actorId})
      returning id`,
      "objects",
    );
    const newMovementId = inserted[0]?.id;
    if (!newMovementId)
      throw new InventoryError("The re-dated completion receipt was not recorded.");
    if (row.total_value === null)
      throw new InventoryError("A completion receipt without value cannot be re-dated.");
    await addLayerAtCost(
      tx as Runner,
      orgId,
      row.subsidiary_id,
      row.item_id,
      row.stock_location_id,
      row.quantity,
      row.total_value,
      method,
      newMovementId,
      correction.correctedOn,
      actorId,
      row.unit_cost ?? undefined,
    );
    await auditChange(tx, {
      orgId,
      actorId,
      table: "inventory_movements",
      rowId: newMovementId,
      action: "insert",
      before: null,
      after: {
        itemId: row.item_id,
        quantity: row.quantity,
        totalValue: row.total_value,
        journalEntryId: redatedEntryId,
        kind: "assembly_build",
        movedAt: correction.correctedOn,
        redatedFromMovementId: row.id,
        reason: correction.reason,
      },
    });
    if (row.serial_id) {
      const serial = await tx.execute<{ id: string }>(
        sql`
        update serials set status='in_stock', current_stock_location_id=${row.stock_location_id}, updated_at=now(), updated_by=${actorId}
         where org_id=${orgId} and id=${row.serial_id} and status='registered' and current_stock_location_id is null
         returning id`,
        "objects",
      );
      if (serial.length !== 1)
        throw new InventoryError(
          "Serial " +
            (row.serial_number ?? "evidence") +
            " changed before the completion date correction.",
        );
    }
    await createReceiptInspection(tx, orgId, actorId, newMovementId, row.id);
    movementIds.push(newMovementId);
  }

  // Receipt evidence follows the re-posted completion, so genealogy keeps the
  // same component allocation under the new entry.
  await tx.execute(sql`
    insert into mfg_completion_batches (org_id, work_order_id, completion_entry_id, allocation_basis, quantity, created_by, updated_by)
    select org_id, work_order_id, ${redatedEntryId}::uuid, allocation_basis, quantity, ${actorId}, ${actorId}
      from mfg_completion_batches where org_id=${orgId} and completion_entry_id=${entry.id}`);
  await tx.execute(sql`
    insert into mfg_completion_inputs (org_id, work_order_id, completion_entry_id, input_movement_id, quantity, created_by, updated_by)
    select org_id, work_order_id, ${redatedEntryId}::uuid, input_movement_id, quantity, ${actorId}, ${actorId}
      from mfg_completion_inputs where org_id=${orgId} and completion_entry_id=${entry.id}`);

  return {
    originalEntryId: entry.id,
    originalEntryNumber: entry.entry_number,
    originalDate: entry.posting_date,
    reversalEntryId,
    redatedEntryId,
    movementIds,
  };
}
