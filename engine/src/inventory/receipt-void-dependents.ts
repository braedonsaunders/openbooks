import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, neg } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { adjustInventory } from "./movements.ts";
import { assertInventoryDate } from "./position.ts";
import { postedReturnQuantity } from "./return-quantities.ts";
import { InventoryError } from "./contracts.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  type TransactionAuditSnapshot,
} from "../records/transaction-audit.ts";

/**
 * What blocks a goods-receipt void, named for the operator. A receipt
 * cannot void while its stock is consumed downstream — and the historic
 * refusal named only the kernel reason. This module lists every live
 * dependent (the issue or transfer that consumed the stock, with its
 * source document and the native path that reverses it), judges whether a
 * void-with-dependents cascade is safe to offer, and corrects a phantom
 * over-receipt's unconsumed remainder through a native inventory
 * adjustment with audit. Posted history stays immutable throughout:
 * every path appends reversals or adjustments, never edits.
 */

export interface ReceiptDependentDocument {
  id: string;
  number: string;
  kind: string;
  status: string;
}

export interface ReceiptVoidDependent {
  issueMovementId: string;
  issueKind: string;
  consumedQuantity: string;
  issueDate: string;
  returnedQuantity: string;
  sourceDocument: ReceiptDependentDocument | null;
  /** True only when the dependent reverses through its own native document void. */
  reversible: boolean;
  /** The operator's next step for this dependent, naming live documents. */
  reverseAction: string;
}

export interface ReceiptVoidBlocker {
  movementId: string;
  itemId: string;
  itemCode: string | null;
  itemName: string;
  receivedQuantity: string;
  consumedQuantity: string;
  remainderQuantity: string;
  dependents: ReceiptVoidDependent[];
  /** Non-consumption blockers: landed cost, provisional chain, custody. */
  otherBlocks: string[];
}

export interface ReceiptVoidRelief {
  receiptId: string;
  receiptNumber: string;
  blockers: ReceiptVoidBlocker[];
  /** True only when every dependent reverses through its own document void. */
  allowVoidWithDependents: boolean;
  /** Unconsumed cover across the receipt's movements. */
  remainderQuantity: string;
}

interface LiveReceiptMovement {
  id: string;
  item_id: string;
  item_code: string | null;
  item_name: string;
  received: string;
  lot_id: string | null;
  serial_id: string | null;
  document_line_id: string;
  stock_location_id: string;
  subsidiary_id: string;
}

/** Live receipt movements behind a goods receipt: posted, never reversed. */
async function liveReceiptMovements(
  runner: SqlExecutor,
  orgId: string,
  receiptId: string,
): Promise<LiveReceiptMovement[]> {
  return (await runner.execute<LiveReceiptMovement>(sql`
    select m.id, m.item_id, i.code as item_code, i.name as item_name,
           m.quantity::text as received, m.lot_id, m.serial_id,
           m.document_line_id, m.stock_location_id, m.subsidiary_id
      from inventory_movements m
      join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
      left join items i on i.id = m.item_id and i.org_id = m.org_id
     where m.org_id = ${orgId} and l.document_id = ${receiptId}
       and m.kind = 'receipt' and m.status = 'posted'
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = m.org_id
            and reversal.reverses_movement_id = m.id
       )
     order by m.id`)).rows;
}

interface LayerRow {
  movement_id: string;
  consumed: string;
  remainder: string;
}

/** Per-movement consumed and remainder cover from the cost layers. */
async function layerCover(
  runner: SqlExecutor,
  orgId: string,
  movementIds: string[],
): Promise<{ cover: Map<string, LayerRow>; layered: Set<string> }> {
  const cover = new Map<string, LayerRow>();
  const layered = new Set<string>();
  if (movementIds.length === 0) return { cover, layered };
  const idArr = `{${movementIds.join(",")}}`;
  const rows = (await runner.execute<{
    movement_id: string;
    consumed: string;
    remainder: string;
  }>(sql`
    select l.source_movement_id as movement_id,
           coalesce(sum(l.original_quantity - l.remaining_quantity), 0)::text as consumed,
           coalesce(sum(l.remaining_quantity), 0)::text as remainder
      from cost_layers l
     where l.org_id = ${orgId} and l.source_movement_id = any(${idArr}::uuid[])
     group by l.source_movement_id`)).rows;
  for (const row of rows) {
    layered.add(row.movement_id);
    cover.set(row.movement_id, row);
  }
  return { cover, layered };
}

interface ConsumptionRow {
  cost_layer_id: string;
  issue_movement_id: string;
  consumed_quantity: string;
  issue_kind: string;
  issue_quantity: string;
  issue_date: string;
  issue_memo: string | null;
  doc_id: string | null;
  doc_number: string | null;
  doc_kind: string | null;
  doc_status: string | null;
  doc_void_requested: string | null;
}

/** Live consumptions of the receipt's layers: issues no reversal has undone. */
async function liveConsumptions(
  runner: SqlExecutor,
  orgId: string,
  movementIds: string[],
): Promise<ConsumptionRow[]> {
  if (movementIds.length === 0) return [];
  const idArr = `{${movementIds.join(",")}}`;
  return (await runner.execute<ConsumptionRow>(sql`
    select c.cost_layer_id, c.issue_movement_id,
           c.quantity::text as consumed_quantity,
           m.kind as issue_kind, m.quantity::text as issue_quantity,
           m.moved_at::date::text as issue_date, m.memo as issue_memo,
           d.id as doc_id, d.document_number as doc_number, d.kind as doc_kind,
           d.status as doc_status, d.void_requested_at::text as doc_void_requested
      from cost_layer_consumptions c
      join cost_layers l on l.id = c.cost_layer_id and l.org_id = c.org_id
      join inventory_movements m on m.id = c.issue_movement_id and m.org_id = c.org_id
      left join document_lines dl on dl.id = m.document_line_id and dl.org_id = m.org_id
      left join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where c.org_id = ${orgId} and l.source_movement_id = any(${idArr}::uuid[])
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = c.org_id
            and reversal.reverses_movement_id = c.issue_movement_id
       )
     order by c.created_at, c.cost_layer_id`)).rows;
}

function reversibleDependent(
  row: ConsumptionRow,
  consumedQuantity: string,
): { reversible: boolean; reverseAction: string; sourceDocument: ReceiptDependentDocument | null } {
  const sourceDocument =
    row.doc_id && row.doc_number && row.doc_kind && row.doc_status
      ? { id: row.doc_id, number: row.doc_number, kind: row.doc_kind, status: row.doc_status }
      : null;
  // A shipment unwinds through its own void, which reverses its issues and
  // restores its sales order — the cascade below drives exactly that path.
  if (
    sourceDocument?.kind === "sales_fulfillment" &&
    (sourceDocument.status === "approved" || sourceDocument.status === "posted") &&
    row.doc_void_requested == null
  ) {
    return {
      reversible: true,
      sourceDocument,
      reverseAction:
        `Void ${sourceDocument.number} (the sales fulfillment), then void this receipt`,
    };
  }
  // A posted invoice's sale is legitimate history with no void path: the
  // goods come back through a credit memo with a goods return, and the
  // receipt stands for the invoiced cover permanently.
  if (sourceDocument?.kind === "customer_invoice") {
    return {
      reversible: false,
      sourceDocument,
      reverseAction:
        `Bring the invoiced units back with a customer credit carrying a goods return ` +
        `against invoice ${sourceDocument.number} for ${consumedQuantity}; ` +
        `the receipt cannot void for cover a posted invoice consumed — that cover is ` +
        `permanent posted history. Correct any overstated remainder with an inventory adjustment instead.`,
    };
  }
  if (sourceDocument) {
    return {
      reversible: false,
      sourceDocument,
      reverseAction:
        `Reverse the consuming ${row.issue_kind} behind ${sourceDocument.kind} ` +
        `${sourceDocument.number} first, then void this receipt`,
    };
  }
  return {
    reversible: false,
    sourceDocument,
    reverseAction:
      `The consuming ${row.issue_kind} of ${consumedQuantity} on ${row.issue_date} ` +
      `carries no source document — reverse that movement first, then void this receipt`,
  };
}

/**
 * Every live blocker on a goods receipt's void: consumed cover per
 * movement with each dependent's source document and native reverse
 * path, plus landed-cost, provisional-chain, and custody blocks. Read
 * only: the void refusal renders this, and the cascade below acts on it.
 */
export async function listReceiptVoidBlockers(
  runner: SqlExecutor,
  orgId: string,
  receiptId: string,
): Promise<ReceiptVoidRelief> {
  const header = (await runner.execute<{ document_number: string }>(sql`
    select document_number from documents
     where id = ${receiptId} and org_id = ${orgId} and kind = 'purchase_receipt'`)).rows[0];
  if (!header) throw new InventoryError("goods receipt not found");
  const movements = await liveReceiptMovements(runner, orgId, receiptId);
  const movementIds = movements.map((movement) => movement.id);
  const { cover } = await layerCover(runner, orgId, movementIds);
  const consumptions = await liveConsumptions(runner, orgId, movementIds);
  const byMovement = new Map<string, ConsumptionRow[]>();
  const layerOwner = new Map<string, string>();
  if (movementIds.length > 0) {
    const idArr = `{${movementIds.join(",")}}`;
    const owners = (await runner.execute<{ id: string; source_movement_id: string }>(sql`
      select id, source_movement_id from cost_layers
       where org_id = ${orgId} and source_movement_id = any(${idArr}::uuid[])`)).rows;
    for (const owner of owners) layerOwner.set(owner.id, owner.source_movement_id);
  }
  for (const row of consumptions) {
    const owner = layerOwner.get(row.cost_layer_id);
    if (!owner) continue;
    const list = byMovement.get(owner) ?? [];
    list.push(row);
    byMovement.set(owner, list);
  }
  const layerIds = [...layerOwner.keys()];
  const landed = new Map<string, number>();
  if (layerIds.length > 0) {
    const rows = (await runner.execute<{ target_cost_layer_id: string; n: number }>(sql`
      select allocation.target_cost_layer_id, count(*)::int as n
        from landed_cost_allocations allocation
       where allocation.org_id = ${orgId}
         and allocation.target_cost_layer_id = any(${`{${layerIds.join(",")}}`}::uuid[])
         and allocation.reverses_allocation_id is null
         and not exists (
           select 1 from landed_cost_allocations reversal
            where reversal.org_id = allocation.org_id
              and reversal.reverses_allocation_id = allocation.id
         )
       group by allocation.target_cost_layer_id`)).rows;
    for (const row of rows) {
      const owner = layerOwner.get(row.target_cost_layer_id);
      if (owner) landed.set(owner, (landed.get(owner) ?? 0) + row.n);
    }
  }
  const settled = new Set(
    movementIds.length > 0
      ? (await runner.execute<{ receipt_movement_id: string }>(sql`
        select receipt_movement_id from inventory_provisional_settlements
         where org_id = ${orgId} and receipt_movement_id = any(${`{${movementIds.join(",")}}`}::uuid[])`)).rows.map(
        (row) => row.receipt_movement_id,
      )
      : [],
  );
  const custody = new Set(
    movementIds.length > 0
      ? (await runner.execute<{ receipt_movement_id: string }>(sql`
        select receipt_movement_id from consignment_events
         where org_id = ${orgId} and receipt_movement_id = any(${`{${movementIds.join(",")}}`}::uuid[]) limit 500`)).rows.map(
        (row) => row.receipt_movement_id,
      )
      : [],
  );
  const blockers: ReceiptVoidBlocker[] = [];
  for (const movement of movements) {
    const movementCover = cover.get(movement.id) ?? { consumed: "0", remainder: movement.received };
    const dependents: ReceiptVoidDependent[] = [];
    for (const row of byMovement.get(movement.id) ?? []) {
      const returned = await postedReturnQuantity(runner, orgId, {
        returnKind: "receipt",
        evidenceKey: "sourceIssueMovementId",
        sourceMovementId: row.issue_movement_id,
      });
      const assessed = reversibleDependent(row, row.consumed_quantity);
      dependents.push({
        issueMovementId: row.issue_movement_id,
        issueKind: row.issue_kind,
        consumedQuantity: row.consumed_quantity,
        issueDate: row.issue_date,
        returnedQuantity: returned,
        sourceDocument: assessed.sourceDocument,
        reversible: assessed.reversible,
        reverseAction: assessed.reverseAction,
      });
    }
    const otherBlocks: string[] = [];
    if ((landed.get(movement.id) ?? 0) > 0) {
      otherBlocks.push(
        "this movement has downstream landed-cost allocations; reverse them before the inventory movement",
      );
    }
    if (settled.has(movement.id)) {
      otherBlocks.push(
        "a receipt that settled negative stock must be reversed through its full provisional-cost chain",
      );
    }
    if (custody.has(movement.id)) {
      otherBlocks.push(
        "Ownership acquisition has custody evidence — use an adjusting inventory transaction; its external custody cannot be silently restored by reversal",
      );
    }
    if (dependents.length === 0 && otherBlocks.length === 0) continue;
    blockers.push({
      movementId: movement.id,
      itemId: movement.item_id,
      itemCode: movement.item_code,
      itemName: movement.item_name,
      receivedQuantity: movement.received,
      consumedQuantity: movementCover.consumed,
      remainderQuantity: movementCover.remainder,
      dependents,
      otherBlocks,
    });
  }
  let remainderQuantity = "0";
  for (const blocker of blockers) remainderQuantity = add(remainderQuantity, blocker.remainderQuantity);
  const allowVoidWithDependents =
    blockers.length > 0 &&
    blockers.every(
      (blocker) =>
        blocker.otherBlocks.length === 0 &&
        blocker.dependents.length > 0 &&
        blocker.dependents.every((dependent) => dependent.reversible),
    );
  return {
    receiptId,
    receiptNumber: header.document_number,
    blockers,
    allowVoidWithDependents,
    remainderQuantity,
  };
}

export interface CorrectReceiptRemainderInput {
  orgId: string;
  actorId: string | null;
  receiptId: string;
  reason: string;
  /** The open-period date carrying the correction; defaults to today. */
  date?: string;
}

export interface CorrectReceiptRemainderResult {
  receiptId: string;
  receiptNumber: string;
  adjustedQuantity: string;
  adjustedLines: { movementId: string; itemId: string; quantity: string }[];
  restoredLines: { purchaseOrderNumber: string; purchaseOrderLineNumber: number; quantity: string }[];
}

/**
 * Correct a phantom over-receipt's unconsumed remainder without voiding
 * the receipt: the leftover leaves through the native inventory
 * adjustment (at carried cost, against the item's adjustment account),
 * each source order line's received counter restores by exactly the
 * adjusted cover, and the receipt keeps its approved status as immutable
 * evidence with the correction audited against it. Refuses when nothing
 * unconsumed remains, when layers were blended beyond exact attribution,
 * or when billed cover would be cut.
 */
export async function correctReceiptRemainder(
  input: CorrectReceiptRemainderInput,
): Promise<CorrectReceiptRemainderResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError("correction reason must be between 5 and 500 characters");
  }
  const today = new Date().toISOString().slice(0, 10);
  const date = input.date ?? today;
  assertInventoryDate(date, "correction date");
  const { orgId, actorId, receiptId } = input;
  return db.transaction(async (tx) => {
    const header = (await tx.execute<{
      document_number: string;
      status: string;
    }>(sql`
      select document_number, status from documents
       where id = ${receiptId} and org_id = ${orgId} and kind = 'purchase_receipt'
       for update`)).rows[0];
    if (!header) throw new InventoryError("goods receipt not found");
    if (header.status !== "approved") {
      throw new InventoryError(
        `only an approved goods receipt can correct its remainder — this receipt is ${header.status}`,
      );
    }
    const receiptLines = (await tx.execute<{
      id: string;
      line_number: number;
      quantity: string;
      source_line_id: string | null;
    }>(sql`
      select l.id, l.line_number, l.quantity::text as quantity,
             l.custom->'receipt'->>'sourceLineId' as source_line_id
        from document_lines l
       where l.document_id = ${receiptId} and l.org_id = ${orgId}
       order by l.line_number`)).rows;
    if (receiptLines.some((line) => !line.source_line_id)) {
      throw new InventoryError(
        "this receipt has a line without order-line provenance — correct the line before adjusting its remainder",
      );
    }
    for (const line of receiptLines) {
      if (!isUuid(line.source_line_id!)) {
        throw new InventoryError(
          "this receipt has a line with malformed order-line provenance — correct the line before adjusting its remainder",
        );
      }
    }
    const movements = await liveReceiptMovements(tx, orgId, receiptId);
    if (movements.length === 0) {
      throw new InventoryError("this receipt holds no live stock movements to correct");
    }
    const movementIds = movements.map((movement) => movement.id);
    const { cover, layered } = await layerCover(tx, orgId, movementIds);
    const blended = movements.filter((movement) => !layered.has(movement.id) && cmp(movement.received, "0") !== 0);
    if (blended.length > 0) {
      throw new InventoryError(
        "the receipt's cost layers were blended into a shared pool — correct the remainder with a manual Inventory Adjust against this receipt instead",
      );
    }
    const remainderByMovement = new Map<string, string>();
    let total = "0";
    for (const movement of movements) {
      const remainder = cover.get(movement.id)?.remainder ?? "0";
      if (cmp(remainder, "0") > 0) {
        remainderByMovement.set(movement.id, remainder);
        total = add(total, remainder);
      }
    }
    if (remainderByMovement.size === 0) {
      throw new InventoryError(
        "this receipt holds no unconsumed remainder — void it whole, or correct it with a manual Inventory Adjust",
      );
    }
    // Lock source headers before their lines (the order-cycle lock order),
    // then restore each line's received counter under the same guards a
    // void faces: never below zero, never into billed cover.
    const sourceIds = [...new Set(receiptLines.map((line) => line.source_line_id!))].sort();
    const idArr = `{${sourceIds.join(",")}}`;
    const orders = (await tx.execute<{ id: string; status: string; document_number: string }>(sql`
      select d.id, d.status, d.document_number
        from documents d
       where d.org_id = ${orgId}
         and d.id in (select l.document_id from document_lines l where l.org_id = ${orgId} and l.id = any(${idArr}::uuid[]))
       order by d.id
       for update`)).rows;
    for (const order of orders) {
      if (order.status !== "approved") {
        throw new InventoryError(
          `purchase order ${order.document_number} is ${order.status} — resolve it before correcting this receipt`,
        );
      }
    }
    const remainderByLine = new Map<string, string>();
    for (const line of receiptLines) {
      let lineRemainder = "0";
      for (const movement of movements.filter((entry) => entry.document_line_id === line.id)) {
        const remainder = remainderByMovement.get(movement.id);
        if (remainder) lineRemainder = add(lineRemainder, remainder);
      }
      if (cmp(lineRemainder, "0") > 0) remainderByLine.set(line.id, lineRemainder);
    }
    const bySource = new Map<string, string>();
    for (const line of receiptLines) {
      const lineRemainder = remainderByLine.get(line.id);
      if (!lineRemainder) continue;
      bySource.set(line.source_line_id!, add(bySource.get(line.source_line_id!) ?? "0", lineRemainder));
    }
    for (const [sourceId, quantity] of bySource) {
      const coverRow = (await tx.execute<{ restorable: boolean; billed_block: boolean }>(sql`
        select (quantity_fulfilled - ${quantity}::numeric) >= 0 as restorable,
               (quantity_fulfilled - ${quantity}::numeric) < quantity_billed as billed_block
          from document_lines where id = ${sourceId} and org_id = ${orgId}
      `)).rows[0];
      if (!coverRow) throw new InventoryError("a source order line is missing — reload and correct again");
      if (!coverRow.restorable) {
        throw new InventoryError("correcting would drive a source line below zero received");
      }
      if (coverRow.billed_block) {
        throw new InventoryError(
          "this receipt's quantities are already billed — reverse the invoice or bill first",
        );
      }
    }
    const beforeSnapshots = new Map<string, TransactionAuditSnapshot>();
    for (const order of orders) {
      const snapshot = await captureTransactionAuditSnapshot(tx, order.id, orgId);
      if (!snapshot) throw new InventoryError("a source order disappeared while it was being corrected");
      beforeSnapshots.set(order.id, snapshot);
    }
    // The stock leg first: the remainder leaves at carried cost through the
    // native adjustment, one call per item, location, lot, and serial so
    // tracked cover keeps its identity.
    const adjustedLines: { movementId: string; itemId: string; quantity: string }[] = [];
    const groups = new Map<string, { movement: LiveReceiptMovement; quantity: string }[]>();
    for (const movement of movements) {
      const remainder = remainderByMovement.get(movement.id);
      if (!remainder) continue;
      const key = `${movement.item_id}:${movement.stock_location_id}:${movement.subsidiary_id}:${movement.lot_id ?? ""}:${movement.serial_id ?? ""}`;
      const list = groups.get(key) ?? [];
      list.push({ movement, quantity: remainder });
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      const first = list[0]!.movement;
      let quantity = "0";
      for (const entry of list) quantity = add(quantity, entry.quantity);
      await adjustInventory(orgId, actorId, {
        itemId: first.item_id,
        stockLocationId: first.stock_location_id,
        quantityDelta: neg(quantity),
        subsidiaryId: first.subsidiary_id,
        date,
        lotId: first.lot_id,
        serialId: first.serial_id,
        memo: `Correct phantom remainder of goods receipt ${header.document_number}: ${reason}`,
        idempotencyKey: `receipt-remainder-${receiptId}-${first.item_id}-${first.stock_location_id}-${first.lot_id ?? ""}-${first.serial_id ?? ""}`,
      });
      for (const entry of list) {
        adjustedLines.push({ movementId: entry.movement.id, itemId: entry.movement.item_id, quantity: entry.quantity });
      }
    }
    // The cover leg: approved lines are storage-immutable, so each source
    // header reopens while its counters restore (the order-cycle pattern),
    // then returns to approved.
    const restoredLines: { purchaseOrderNumber: string; purchaseOrderLineNumber: number; quantity: string }[] = [];
    for (const order of orders) {
      const reopened = (await tx.execute<{ id: string }>(sql`
        update documents set status = 'draft', updated_at = now(), updated_by = ${actorId}
         where id = ${order.id} and org_id = ${orgId} and status = 'approved'
        returning id`)).rows[0];
      if (!reopened) throw new InventoryError("the source order changed while it was being corrected");
      const orderSources = (await tx.execute<{ id: string; line_number: number; document_number: string }>(sql`
        select l.id, l.line_number, d.document_number
          from document_lines l
          join documents d on d.id = l.document_id and d.org_id = l.org_id
         where l.org_id = ${orgId} and l.document_id = ${order.id} and l.id = any(${idArr}::uuid[])`)).rows;
      for (const source of orderSources) {
        const quantity = bySource.get(source.id);
        if (!quantity) continue;
        const restored = (await tx.execute<{ id: string }>(sql`
          update document_lines
             set quantity_fulfilled = quantity_fulfilled - ${quantity}::numeric, updated_at = now(), updated_by = ${actorId}
           where id = ${source.id} and org_id = ${orgId}
             and quantity_fulfilled - ${quantity}::numeric >= 0
          returning id`)).rows[0];
        if (!restored) throw new InventoryError("a source order line changed while it was being corrected");
        restoredLines.push({
          purchaseOrderNumber: source.document_number,
          purchaseOrderLineNumber: source.line_number,
          quantity,
        });
      }
      const reapproved = (await tx.execute<{ id: string }>(sql`
        update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
         where id = ${order.id} and org_id = ${orgId} and status = 'draft'
        returning id`)).rows[0];
      if (!reapproved) throw new InventoryError("the source order changed while it was being corrected");
    }
    for (const order of orders) {
      const after = await captureTransactionAuditSnapshot(tx, order.id, orgId);
      await recordTransactionAudit(tx, {
        orgId,
        documentId: order.id,
        action: "update",
        actorId,
        source: "receipt_remainder_correction",
        reason,
        before: beforeSnapshots.get(order.id)!,
        after,
      });
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'documents', ${receiptId}, 'update',
              ${JSON.stringify({
                mode: "receipt_remainder_corrected",
                correctionDate: date,
                reason,
                adjustedQuantity: total,
                adjustedLines: adjustedLines.map((line) => ({
                  itemId: line.itemId,
                  quantity: line.quantity,
                })),
                restoredLines,
              })}::jsonb, ${actorId})
    `);
    return {
      receiptId,
      receiptNumber: header.document_number,
      adjustedQuantity: total,
      adjustedLines,
      restoredLines,
    };
  });
}
