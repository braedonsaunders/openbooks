import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, neg } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { adjustInventory } from "./movements.ts";
import { assertInventoryDate } from "./position.ts";
import { InventoryError } from "./contracts.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  type TransactionAuditSnapshot,
} from "../records/transaction-audit.ts";
import {
  liveReceiptMovements,
  layerCover,
  lockReceiptInventoryPositions,
} from "./receipt-void-state.ts";

/** Correcting the undelivered remainder of a purchase receipt that is partly consumed, without voiding the consumed part. */

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
  restoredLines: {
    purchaseOrderNumber: string;
    purchaseOrderLineNumber: number;
    quantity: string;
  }[];
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
    await lockReceiptInventoryPositions(tx, orgId, receiptId);
    const header = (
      await tx.execute<{
        document_number: string;
        status: string;
      }>(
        sql`
      select document_number, status from documents
       where id = ${receiptId} and org_id = ${orgId} and kind = 'purchase_receipt'
       for update`,
        "objects",
      )
    )[0];
    if (!header) throw new InventoryError("goods receipt not found");
    if (header.status !== "approved") {
      throw new InventoryError(
        `only an approved goods receipt can correct its remainder — this receipt is ${header.status}`,
      );
    }
    const receiptLines = await tx.execute<{
      id: string;
      line_number: number;
      quantity: string;
      source_line_id: string | null;
    }>(
      sql`
      select l.id, l.line_number, l.quantity::text as quantity,
             l.custom->'receipt'->>'sourceLineId' as source_line_id
        from document_lines l
       where l.document_id = ${receiptId} and l.org_id = ${orgId}
       order by l.line_number`,
      "objects",
    );
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
    const blended = movements.filter(
      (movement) => !layered.has(movement.id) && cmp(movement.received, "0") !== 0,
    );
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
    const orders = await tx.execute<{ id: string; status: string; document_number: string }>(
      sql`
      select d.id, d.status, d.document_number
        from documents d
       where d.org_id = ${orgId}
         and d.id in (select l.document_id from document_lines l where l.org_id = ${orgId} and l.id = any(${idArr}::uuid[]))
       order by d.id
       for update`,
      "objects",
    );
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
      bySource.set(
        line.source_line_id!,
        add(bySource.get(line.source_line_id!) ?? "0", lineRemainder),
      );
    }
    for (const [sourceId, quantity] of bySource) {
      const coverRow = (
        await tx.execute<{ restorable: boolean; billed_block: boolean }>(
          sql`
        select (quantity_fulfilled - ${quantity}::numeric) >= 0 as restorable,
               (quantity_fulfilled - ${quantity}::numeric) < quantity_billed as billed_block
          from document_lines where id = ${sourceId} and org_id = ${orgId}
      `,
          "objects",
        )
      )[0];
      if (!coverRow)
        throw new InventoryError("a source order line is missing — reload and correct again");
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
      if (!snapshot)
        throw new InventoryError("a source order disappeared while it was being corrected");
      beforeSnapshots.set(order.id, snapshot);
    }
    // The stock leg first: the remainder leaves at carried cost through the
    // native adjustment, one call per item, location, lot, and serial so
    // tracked cover keeps its identity.
    const adjustedLines: { movementId: string; itemId: string; quantity: string }[] = [];
    for (const movement of movements) {
      const quantity = remainderByMovement.get(movement.id);
      if (!quantity) continue;
      await adjustInventory(orgId, actorId, {
        itemId: movement.item_id,
        stockLocationId: movement.stock_location_id,
        quantityDelta: neg(quantity),
        subsidiaryId: movement.subsidiary_id,
        date,
        lotId: movement.lot_id,
        serialId: movement.serial_id,
        documentLineId: movement.document_line_id,
        tx,
        memo: `Correct phantom remainder of goods receipt ${header.document_number}: ${reason}`,
        idempotencyKey: `receipt-remainder-${receiptId}-${movement.id}`,
      });
      adjustedLines.push({ movementId: movement.id, itemId: movement.item_id, quantity });
    }
    // The cover leg: approved lines are storage-immutable, so each source
    // header reopens while its counters restore (the order-cycle pattern),
    // then returns to approved.
    const restoredLines: {
      purchaseOrderNumber: string;
      purchaseOrderLineNumber: number;
      quantity: string;
    }[] = [];
    for (const order of orders) {
      const reopened = (
        await tx.execute<{ id: string }>(
          sql`
        update documents set status = 'draft', updated_at = now(), updated_by = ${actorId}
         where id = ${order.id} and org_id = ${orgId} and status = 'approved'
        returning id`,
          "objects",
        )
      )[0];
      if (!reopened)
        throw new InventoryError("the source order changed while it was being corrected");
      const orderSources = await tx.execute<{
        id: string;
        line_number: number;
        document_number: string;
      }>(
        sql`
        select l.id, l.line_number, d.document_number
          from document_lines l
          join documents d on d.id = l.document_id and d.org_id = l.org_id
         where l.org_id = ${orgId} and l.document_id = ${order.id} and l.id = any(${idArr}::uuid[])`,
        "objects",
      );
      for (const source of orderSources) {
        const quantity = bySource.get(source.id);
        if (!quantity) continue;
        const restored = (
          await tx.execute<{ id: string }>(
            sql`
          update document_lines
             set quantity_fulfilled = quantity_fulfilled - ${quantity}::numeric, updated_at = now(), updated_by = ${actorId}
           where id = ${source.id} and org_id = ${orgId}
             and quantity_fulfilled - ${quantity}::numeric >= 0
          returning id`,
            "objects",
          )
        )[0];
        if (!restored)
          throw new InventoryError("a source order line changed while it was being corrected");
        restoredLines.push({
          purchaseOrderNumber: source.document_number,
          purchaseOrderLineNumber: source.line_number,
          quantity,
        });
      }
      const reapproved = (
        await tx.execute<{ id: string }>(
          sql`
        update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
         where id = ${order.id} and org_id = ${orgId} and status = 'draft'
        returning id`,
          "objects",
        )
      )[0];
      if (!reapproved)
        throw new InventoryError("the source order changed while it was being corrected");
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
