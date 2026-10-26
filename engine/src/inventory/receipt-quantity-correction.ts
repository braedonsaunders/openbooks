import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, neg } from "../money/money.ts";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
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

/** Correcting a consumed purchase receipt line to its delivered quantity through a shrink adjustment. */

export interface CorrectReceiptQuantityLineInput {
  /** The goods-receipt line to correct. */
  receiptLineId: string;
  /** The quantity the vendor actually delivered on that line. */
  correctedQuantity: string;
}

export interface CorrectReceiptQuantityInput {
  orgId: string;
  actorId: string | null;
  receiptId: string;
  lines: CorrectReceiptQuantityLineInput[];
  reason: string;
  /** The open-period date carrying the correction; defaults to today. */
  date?: string;
}

export interface CorrectReceiptQuantityResult {
  receiptId: string;
  receiptNumber: string;
  adjustedQuantity: string;
  correctedLines: {
    receiptLineId: string;
    lineNumber: number;
    receivedQuantity: string;
    correctedQuantity: string;
    adjustedQuantity: string;
  }[];
  restoredLines: {
    purchaseOrderNumber: string;
    purchaseOrderLineNumber: number;
    quantity: string;
  }[];
}

function parseCorrectedQuantity(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new InventoryError(`${label} corrected quantity must be decimal text`);
  }
  let units: bigint;
  try {
    units = toQuantityUnits(value);
  } catch {
    throw new InventoryError(
      `${label} corrected quantity must be a non-negative quantity with at most eight decimals`,
    );
  }
  if (units < 0n) {
    throw new InventoryError(`${label} corrected quantity cannot be negative`);
  }
  return fromQuantityUnits(units);
}

/**
 * Correct a receipt line's quantity when only the purchase-side count was
 * wrong and the customer keeps the goods: the sale (or other consumption)
 * stands, and the over-received quantity leaves through the native
 * inventory adjustment at carried cost — a shrink to the true delivered
 * quantity — with each source order line's received counter restored by
 * exactly the adjusted cover. The receipt keeps its approved status as
 * immutable evidence with the correction audited against it.
 *
 * Refuses when a line's corrected quantity is at or above what the
 * receipt recorded (receive the shortfall through the purchase order
 * instead), when the over-received quantity exceeds what the line still
 * holds unconsumed (the phantom units already left through a sale — claim
 * the short delivery on an account-only vendor credit instead), when
 * layers were blended beyond exact attribution, or when billed cover
 * would be cut (reverse the bill first).
 */
export async function correctReceiptQuantity(
  input: CorrectReceiptQuantityInput,
): Promise<CorrectReceiptQuantityResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError("correction reason must be between 5 and 500 characters");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) {
    throw new InventoryError(
      "correction names one to five hundred receipt lines with corrected quantities",
    );
  }
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!line || !isUuid(line.receiptLineId)) {
      throw new InventoryError("correction lines each name a receipt line");
    }
    if (seen.has(line.receiptLineId)) {
      throw new InventoryError("a receipt line can be corrected once per request");
    }
    seen.add(line.receiptLineId);
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
        `only an approved goods receipt can correct its quantity — this receipt is ${header.status}`,
      );
    }
    const receiptLines = await tx.execute<{
      id: string;
      line_number: number;
      item_id: string;
      quantity: string;
      correction_quantity: string;
      source_line_id: string | null;
    }>(
      sql`
      select l.id, l.line_number, l.item_id, l.quantity::text as quantity,
             (select coalesce(sum(c.quantity + coalesce((
                select sum(r.quantity) from inventory_movements r
                 where r.org_id = c.org_id and r.reverses_movement_id = c.id and r.status = 'posted'
              ), 0)), 0)::text
                from inventory_movements c
               where c.org_id = l.org_id and c.document_line_id = l.id
                 and c.kind = 'issue' and c.status = 'posted'
                 and (c.idempotency_key like 'receipt-remainder-%'
                      or c.idempotency_key like 'receipt-quantity-%')) as correction_quantity,
             l.custom->'receipt'->>'sourceLineId' as source_line_id
        from document_lines l
       where l.document_id = ${receiptId} and l.org_id = ${orgId}
       order by l.line_number`,
      "objects",
    );
    const byLineId = new Map(receiptLines.map((line) => [line.id, line]));
    for (const line of receiptLines) {
      if (!line.source_line_id || !isUuid(line.source_line_id)) {
        throw new InventoryError(
          "this receipt has a line without order-line provenance — correct the line before adjusting its quantity",
        );
      }
    }
    const targets: {
      line: (typeof receiptLines)[number];
      current: string;
      corrected: string;
      over: string;
    }[] = [];
    for (const request of input.lines) {
      const line = byLineId.get(request.receiptLineId);
      if (!line) {
        throw new InventoryError(
          "a corrected line is not on this receipt — reload and correct again",
        );
      }
      const label = `goods-receipt line ${line.line_number}`;
      const corrected = parseCorrectedQuantity(request.correctedQuantity, label);
      const current = fromQuantityUnits(
        toQuantityUnits(line.quantity) + toQuantityUnits(line.correction_quantity),
      );
      const over = fromQuantityUnits(toQuantityUnits(current) - toQuantityUnits(corrected));
      if (cmp(over, "0") === 0) {
        throw new InventoryError(
          `${label} already records ${current} — nothing to correct; receive a shortfall through the purchase order instead`,
        );
      }
      if (cmp(over, "0") < 0) {
        throw new InventoryError(
          `${label} records ${current} but the correction raises it to ${corrected} — receive the shortfall through the purchase order instead`,
        );
      }
      targets.push({ line, current, corrected, over });
    }
    const movements = await liveReceiptMovements(tx, orgId, receiptId);
    if (movements.length === 0) {
      throw new InventoryError("this receipt holds no live stock movements to correct");
    }
    const movementIds = movements.map((movement) => movement.id);
    const { cover, layered } = await layerCover(tx, orgId, movementIds);
    const targetMovementIds = new Set(
      movements
        .filter((movement) =>
          targets.some((target) => target.line.id === movement.document_line_id),
        )
        .map((movement) => movement.id),
    );
    const blended = movements.filter(
      (movement) =>
        targetMovementIds.has(movement.id) &&
        !layered.has(movement.id) &&
        cmp(movement.received, "0") !== 0,
    );
    if (blended.length > 0) {
      throw new InventoryError(
        "the receipt's cost layers were blended into a shared pool — correct the quantity with a manual Inventory Adjust against this receipt instead",
      );
    }
    const remainderByMovement = new Map<string, string>();
    for (const movement of movements) {
      if (!targetMovementIds.has(movement.id)) continue;
      const remainder = cover.get(movement.id)?.remainder ?? "0";
      if (cmp(remainder, "0") > 0) remainderByMovement.set(movement.id, remainder);
    }
    const correctedLines: CorrectReceiptQuantityResult["correctedLines"] = [];
    const remainderByLine = new Map<string, string>();
    let total = "0";
    for (const target of targets) {
      let lineRemainder = "0";
      for (const movement of movements.filter(
        (entry) => entry.document_line_id === target.line.id,
      )) {
        const remainder = remainderByMovement.get(movement.id);
        if (remainder) lineRemainder = add(lineRemainder, remainder);
      }
      // The phantom units must still be on hand: whatever already left
      // through a sale belongs to the sale, and the vendor's short
      // delivery is claimed on an account-only vendor credit instead.
      if (cmp(target.over, lineRemainder) > 0) {
        throw new InventoryError(
          `goods-receipt line ${target.line.line_number} records ${target.line.quantity} but only ${lineRemainder} remains unconsumed — ` +
            `the rest already left through a sale or transfer the correction cannot reverse. ` +
            `Correct to no less than ${fromQuantityUnits(toQuantityUnits(target.current) - toQuantityUnits(lineRemainder))}, ` +
            `and claim the vendor's short delivery on an account-only vendor credit instead`,
        );
      }
      remainderByLine.set(target.line.id, target.over);
      correctedLines.push({
        receiptLineId: target.line.id,
        lineNumber: target.line.line_number,
        receivedQuantity: target.current,
        correctedQuantity: target.corrected,
        adjustedQuantity: target.over,
      });
    }
    // Lock source headers before their lines (the order-cycle lock order),
    // then restore each line's received counter under the same guards a
    // void faces: never below zero, never into billed cover.
    const sourceIds = [...new Set(targets.map((target) => target.line.source_line_id!))].sort();
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
    const bySource = new Map<string, string>();
    for (const target of targets) {
      const over = remainderByLine.get(target.line.id);
      if (!over) continue;
      bySource.set(
        target.line.source_line_id!,
        add(bySource.get(target.line.source_line_id!) ?? "0", over),
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
    // The stock leg first: the over-received quantity leaves at carried
    // cost through the native adjustment — the sale stands — one call per
    // item, location, lot, and serial so tracked cover keeps its identity.
    // A line split across lots distributes its over-receipt pro-rata over
    // the remainders (floored, residual to the last), so the shares sum
    // to the over-receipt exactly.
    for (const target of targets) {
      const over = remainderByLine.get(target.line.id);
      if (!over) continue;
      const lineMovements = movements.filter(
        (entry) => entry.document_line_id === target.line.id && remainderByMovement.has(entry.id),
      );
      const remainders = lineMovements.map((movement) =>
        toQuantityUnits(remainderByMovement.get(movement.id)!),
      );
      const remainderTotal = remainders.reduce((sum, remainder) => sum + remainder, 0n);
      if (remainderTotal <= 0n) continue;
      const overUnits = toQuantityUnits(over);
      let assigned = 0n;
      for (let index = 0; index < lineMovements.length; index += 1) {
        const movement = lineMovements[index]!;
        const share =
          index < lineMovements.length - 1
            ? (overUnits * remainders[index]!) / remainderTotal
            : overUnits - assigned;
        assigned += share;
        if (share <= 0n) continue;
        const quantity = fromQuantityUnits(share);
        total = add(total, quantity);
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
          memo: `Correct receipt quantity for goods receipt ${header.document_number}: ${reason}`,
          idempotencyKey: `receipt-quantity-${receiptId}-${movement.id}-${target.corrected}`,
        });
      }
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
        source: "receipt_quantity_correction",
        reason,
        before: beforeSnapshots.get(order.id)!,
        after,
      });
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'documents', ${receiptId}, 'update',
              ${JSON.stringify({
                mode: "receipt_quantity_corrected",
                correctionDate: date,
                reason,
                adjustedQuantity: total,
                correctedLines: correctedLines.map((line) => ({
                  receiptLineId: line.receiptLineId,
                  receivedQuantity: line.receivedQuantity,
                  correctedQuantity: line.correctedQuantity,
                  adjustedQuantity: line.adjustedQuantity,
                })),
                restoredLines,
              })}::jsonb, ${actorId})
    `);
    return {
      receiptId,
      receiptNumber: header.document_number,
      adjustedQuantity: total,
      correctedLines,
      restoredLines,
    };
  });
}
