import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  assertPeriodModulesOpen,
  CloseError,
  periodClosedDetailsOf,
} from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  type TransactionAuditSnapshot,
} from "../records/transaction-audit.ts";
import { cmp, toUnits } from "../money/money.ts";
import { DownstreamConsumptionError, InventoryError } from "../inventory/contracts.ts";
import { reverseInventoryJournal, reverseInventoryMovement } from "../inventory/reversal.ts";
import { postedReturnQuantity } from "../inventory/return-quantities.ts";
import { listReceiptVoidBlockers } from "../inventory/receipt-void-dependents.ts";
import {
  crossSubsidiaryFulfillmentHandler,
  crossSubsidiaryShipment,
} from "../inventory/cross-subsidiary.ts";
import { isUuid } from "../platform/uuid.ts";
import { DocumentVoidError, voidCloseModule } from "./document-void-shared.ts";

function dependentKindLabel(kind: string): string {
  if (kind === "sales_fulfillment") return "sales fulfillment";
  if (kind === "customer_invoice") return "invoice";
  if (kind === "purchase_receipt") return "goods receipt";
  return kind;
}

/**
 * The actionable refusal for a receipt whose stock was consumed
 * downstream: every dependent named with its source document, each with
 * its native reverse path; the unconsumed remainder named for the
 * adjustment path; and the cascade offer exactly when every dependent
 * reverses through its own document void. The machine-readable form
 * travels in `details` for the void dialog's actions.
 */
async function receiptConsumptionRefusal(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  receiptId: string,
): Promise<DocumentVoidError> {
  const relief = await listReceiptVoidBlockers(tx, orgId, receiptId);
  const lines = [
    `Goods receipt ${relief.receiptNumber} cannot void — its stock has downstream consumption:`,
  ];
  for (const blocker of relief.blockers) {
    const itemLabel = blocker.itemCode ?? blocker.itemName;
    for (const dependent of blocker.dependents) {
      const doc = dependent.sourceDocument;
      const returned =
        cmp(dependent.returnedQuantity, "0") > 0
          ? ` (${dependent.returnedQuantity} already returned)`
          : "";
      lines.push(
        `${dependent.consumedQuantity} of ${itemLabel} consumed by ` +
          (doc
            ? `${dependentKindLabel(doc.kind)} ${doc.number}`
            : "a movement with no source document") +
          ` on ${dependent.issueDate}${returned}. ${dependent.reverseAction}`,
      );
    }
    for (const other of blocker.otherBlocks) lines.push(other);
  }
  if (cmp(relief.remainderQuantity, "0") > 0) {
    lines.push(
      `Unconsumed remainder on this receipt: ${relief.remainderQuantity} — ` +
        `correct a phantom over-delivery with an inventory adjustment (Adjust remainder) instead of voiding.`,
    );
  }
  if (relief.allowVoidWithDependents) {
    lines.push(
      "Every dependent reverses through its own document void — Void with dependents is available.",
    );
  }
  return new DocumentVoidError(lines.join(" "), 422, "receipt-stock-consumed", {
    receiptNumber: relief.receiptNumber,
    blockers: relief.blockers,
    allowVoidWithDependents: relief.allowVoidWithDependents,
    remainderQuantity: relief.remainderQuantity,
  });
}

/**
 * The closed-period fence the posted-document path runs for an order
 * shipment's reversal journals. Receipts and fulfillments post the same
 * inventory journals a bill void reverses, but carry no posted entry of
 * their own — so the GL-only check would wave a module-closed period through.
 * One shared predicate judges the reversal date's covering period the way
 * the posted path does (payables for a receipt,
 * receivables for a shipment): a missing period names its remedy, a
 * closed one refuses typed with the route out. No journals behind the
 * document means nothing to fence.
 */
async function assertOrderShipmentReversalPeriodOpen(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    voidKind: "purchase_receipt" | "sales_fulfillment";
    voidDocumentId: string;
    reversalDate: string;
  },
): Promise<void> {
  const movementKind = input.voidKind === "sales_fulfillment" ? "issue" : "receipt";
  const books = await tx.execute<{ book_id: string }>(
    sql`
    select distinct e.book_id
      from inventory_movements movement
      join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
      join journal_entries e on e.id = movement.journal_entry_id and e.org_id = movement.org_id
     where movement.org_id = ${input.orgId} and line.document_id = ${input.voidDocumentId}
       -- Live entries only: a reversed entry cannot be reversed again
       and movement.kind = ${movementKind} and movement.status = 'posted' and e.status = 'posted'`,
    "objects",
  );
  const bookIds = [...new Set(books.map((row) => row.book_id))];
  if (bookIds.length === 0) return;
  const subsidiaries = await tx.execute<{ subsidiary_id: string }>(
    sql`
    select distinct movement.subsidiary_id
      from inventory_movements movement
      join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
     where movement.org_id = ${input.orgId} and line.document_id = ${input.voidDocumentId}
       and movement.kind = ${movementKind} and movement.status = 'posted'`,
    "objects",
  );
  for (const bookId of bookIds)
    for (const subsidiary of subsidiaries) {
      const period = await resolveCoveringPeriod(
        tx,
        input.orgId,
        input.reversalDate,
        subsidiary.subsidiary_id,
      );
      if (!period)
        throw new DocumentVoidError(
          `no entity accounting period covers ${input.reversalDate} — generate the period covering that date, then void again`,
          422,
          "reversal-period-uncovered",
        );
      try {
        await assertPeriodModulesOpen(tx, {
          orgId: input.orgId,
          periodId: period.id,
          bookId,
          subsidiaryIds: [subsidiary.subsidiary_id],
          modules: [voidCloseModule(input.voidKind)],
        });
      } catch (error) {
        if (error instanceof CloseError) {
          throw new DocumentVoidError(
            `the reversal period for ${input.reversalDate} is closed: ${error.message}`,
            422,
            "reversal-period-closed",
            periodClosedDetailsOf(error),
          );
        }
        throw error;
      }
    }
}

/**
 * Name every live downstream consumption of a bill's receipt movements
 * for the void refusal, with the native reverse path for each consumer:
 * a shipment voids through its own document void, a posted invoice's sale
 * comes back through a customer credit with a goods return, anything else
 * reverses through its own document first. Every remedy named exists.
 */
async function billConsumptionRefusal(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  billId: string,
  billNumber: string,
): Promise<DocumentVoidError> {
  const rows = await tx.execute<{
    quantity: string;
    item_code: string | null;
    item_name: string;
    consumed_quantity: string;
    issue_kind: string;
    issue_date: string;
    doc_number: string | null;
    doc_kind: string | null;
  }>(
    sql`
    select m.quantity::text as quantity, i.code as item_code, i.name as item_name,
           c.quantity::text as consumed_quantity, im.kind as issue_kind,
           im.moved_at::date::text as issue_date,
           d.document_number as doc_number, d.kind as doc_kind
      from inventory_movements m
      join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
      left join items i on i.id = m.item_id and i.org_id = m.org_id
      join cost_layers layer on layer.org_id = m.org_id and layer.source_movement_id = m.id
      join cost_layer_consumptions c on c.org_id = layer.org_id and c.cost_layer_id = layer.id
      join inventory_movements im on im.id = c.issue_movement_id and im.org_id = c.org_id
      left join document_lines il on il.id = im.document_line_id and il.org_id = im.org_id
      left join documents d on d.id = il.document_id and d.org_id = il.org_id
     where m.org_id = ${orgId} and l.document_id = ${billId}
       and m.kind = 'receipt' and m.status = 'posted'
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = m.org_id and reversal.reverses_movement_id = m.id
       )
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = im.org_id and reversal.reverses_movement_id = im.id
       )
     order by m.id, im.moved_at, im.id`,
    "objects",
  );
  const lines = [`Bill ${billNumber} cannot void — stock it received has downstream consumption:`];
  for (const row of rows) {
    const itemLabel = row.item_code ?? row.item_name;
    const consumer = row.doc_number
      ? `${row.doc_kind} ${row.doc_number}`
      : `a movement with no source document`;
    const remedy =
      row.doc_kind === "sales_fulfillment"
        ? `Void ${row.doc_number} (the sales fulfillment), then void this bill`
        : row.doc_kind === "customer_invoice"
          ? `Bring the invoiced units back with a customer credit carrying a goods return against invoice ${row.doc_number}, then void this bill`
          : `Reverse the consuming ${row.issue_kind} behind ${consumer} first, then void this bill`;
    lines.push(
      `${row.consumed_quantity} of ${itemLabel} consumed by ${row.issue_kind} ${consumer} on ${row.issue_date}. ${remedy}`,
    );
  }
  if (rows.length === 0) {
    lines.push(
      "its received stock was consumed downstream — reverse the consuming sale, transfer, or adjustment first, then void this bill",
    );
  }
  return new DocumentVoidError(lines.join(" "), 422, "bill-stock-consumed");
}

/**
 * Unwind a vendor bill's inventory receipts inside the caller's void
 * transaction: every still-live receipt movement on the bill's lines
 * reverses through the inventory kernel with its journal, and every
 * purchase price variance entry the bill settled reverses with it, so a
 * bill that brought stock in voids clean instead of stranding phantom
 * inventory. Matched bills additionally walk their billed cover back
 * through billing provenance after the journals reverse. Only movements
 * with no reversal row count as live. Consumed stock refuses naming its
 * consumers with their native reverse paths; anything else the kernel
 * cannot unwind keeps the manual two-leg correction the void gate below
 * names (an account-only vendor credit plus an inventory adjustment).
 */
export async function reverseBillInventoryReceipts(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    billId: string;
    billNumber: string;
    actorId: string;
    reversalDate: string;
    reason: string;
  },
): Promise<void> {
  const liveMovements = await tx.execute<{ id: string }>(
    sql`
    select movement.id
      from inventory_movements movement
      join document_lines line
        on line.id = movement.document_line_id and line.org_id = movement.org_id
     where movement.org_id = ${input.orgId}
       and line.document_id = ${input.billId}
       and movement.kind = 'receipt'
       and movement.status = 'posted'
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = movement.org_id
            and reversal.reverses_movement_id = movement.id
       )
     order by movement.id
     for update of movement
  `,
    "objects",
  );
  for (const movement of liveMovements) {
    try {
      await reverseInventoryMovement(input.orgId, input.actorId, {
        movementId: movement.id,
        reversalDate: input.reversalDate,
        reason: input.reason,
      });
    } catch (error) {
      if (error instanceof DownstreamConsumptionError) {
        throw await billConsumptionRefusal(tx, input.orgId, input.billId, input.billNumber);
      }
      // Anything else the kernel cannot unwind (landed cost, custody,
      // provisional chain, blended provenance) keeps the governed manual
      // correction: the void gate below refuses with the account-only
      // vendor credit plus inventory adjustment remedy.
      throw error;
    }
  }
  // Purchase price variance the bill settled against its goods receipts
  // reverses with the bill: without this the variance leg would strand
  // while the bill and the receipt both unwind.
  const billLines = await tx.execute<{ id: string }>(
    sql`
    select id from document_lines
     where org_id = ${input.orgId} and document_id = ${input.billId}
  `,
    "objects",
  );
  for (const line of billLines) {
    const entryNumber = `INV-PPV-${line.id}`;
    const ppv = (
      await tx.execute<{ id: string }>(
        sql`
      select id from journal_entries
       -- Live entries only: a reversed entry cannot be reversed again
       where org_id = ${input.orgId} and entry_number = ${entryNumber} and status = 'posted'
    `,
        "objects",
      )
    )[0];
    if (!ppv) continue;
    try {
      await reverseInventoryJournal(
        tx,
        input.orgId,
        input.actorId,
        ppv.id,
        input.reversalDate,
        input.reason,
      );
    } catch (error) {
      if (error instanceof InventoryError) {
        throw new DocumentVoidError(
          `bill ${input.billNumber} cannot void yet — its purchase price variance entry ${entryNumber} cannot reverse: ${error.message}`,
        );
      }
      throw error;
    }
  }
}

/**
 * Unwind one shipment (sales_fulfillment) or goods receipt
 * (purchase_receipt) inside the caller's void transaction: reverse every
 * still-live stock movement through the inventory kernel and restore the
 * source order lines' fulfilled counters, so the quantities can ship again
 * and no stock is stranded.
 *
 * Only movements with no reversal row count as live: the kernel keeps the
 * original movement posted and records the reversal as a separate `return`
 * movement, so an already-reversed leg is never reversed twice. A refused
 * unwind names its real blocker (billed quantities, missing provenance, or
 * the kernel's own reason such as downstream inventory activity).
 */
export async function reverseOrderShipment(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    voidDocumentId: string;
    voidKind: string;
    actorId: string;
    reversalDate: string;
    reason: string;
  },
): Promise<void> {
  // Order shipments carry no posted entry, so the completion fence for
  // posted documents never sees them — yet their reversal journals post
  // all the same. Refuse a closed reversal period here, before the stock
  // unwind, with the same typed refusal the posted path renders: the
  // operator picks another date first, then meets any stock blockers.
  if (input.voidKind === "purchase_receipt" || input.voidKind === "sales_fulfillment") {
    await assertOrderShipmentReversalPeriodOpen(tx, {
      orgId: input.orgId,
      voidKind: input.voidKind,
      voidDocumentId: input.voidDocumentId,
      reversalDate: input.reversalDate,
    });
  }
  const evidenceKey = input.voidKind === "sales_fulfillment" ? "fulfillment" : "receipt";
  const movementKind = input.voidKind === "sales_fulfillment" ? "issue" : "receipt";
  const voidQtyBySource = await tx.execute<{
    source_line_id: string | null;
    void_quantity: string;
  }>(
    sql`
    select l.custom->${evidenceKey}->>'sourceLineId' as source_line_id,
           sum(l.quantity)::text as void_quantity
      from document_lines l
     where l.document_id = ${input.voidDocumentId} and l.org_id = ${input.orgId}
     group by 1
  `,
    "objects",
  );
  if (voidQtyBySource.some((row) => !row.source_line_id)) {
    throw new DocumentVoidError(
      "this document has a line without order-line provenance — correct the line before voiding",
    );
  }
  if (voidQtyBySource.length > 0) {
    const sources = voidQtyBySource as { source_line_id: string; void_quantity: string }[];
    // Malformed legacy provenance must refuse as a controlled void error,
    // never as a raw SQL cast failure from the uuid[] predicates below.
    for (const source of sources) {
      if (!isUuid(source.source_line_id)) {
        throw new DocumentVoidError(
          "this document has a line with malformed order-line provenance — correct the line before voiding",
        );
      }
    }
    const expectedOrderKind =
      input.voidKind === "sales_fulfillment" ? "sales_order" : "purchase_order";
    const idArr = `{${sources.map((row) => row.source_line_id).join(",")}}`;
    // Lock source headers before their lines (the order-cycle lock order),
    // then the lines, so concurrent fulfill/receive commands serialize.
    const orders = await tx.execute<{ id: string; status: string; kind: string }>(
      sql`
      select d.id, d.status, d.kind
        from documents d
       where d.org_id = ${input.orgId}
         and d.id in (
           select l.document_id from document_lines l
            where l.org_id = ${input.orgId} and l.id = any(${idArr}::uuid[])
         )
       order by d.id
       for update
    `,
      "objects",
    );
    for (const order of orders) {
      if (order.kind !== expectedOrderKind) {
        throw new DocumentVoidError(
          "a source line does not belong to an order of the expected kind — correct the line before voiding",
        );
      }
    }
    const orderByLine = new Map<string, { id: string; status: string; kind: string }>();
    for (const order of orders) {
      const lineIds = await tx.execute<{ id: string }>(
        sql`
        select l.id from document_lines l
         where l.org_id = ${input.orgId} and l.document_id = ${order.id}
           and l.id = any(${idArr}::uuid[])
      `,
        "objects",
      );
      for (const line of lineIds) orderByLine.set(line.id, order);
    }
    if (orderByLine.size !== sources.length) {
      throw new DocumentVoidError("a source order line for this document is missing");
    }
    const sourceLines = await tx.execute<{ id: string }>(
      sql`
      select l.id from document_lines l
       where l.org_id = ${input.orgId} and l.id = any(${idArr}::uuid[])
       order by l.id
       for update of l
    `,
      "objects",
    );
    if (sourceLines.length !== sources.length) {
      throw new DocumentVoidError("a source order line changed while it was being voided");
    }
    for (const source of sources) {
      const order = orderByLine.get(source.source_line_id)!;
      if (order.status !== "approved") {
        throw new DocumentVoidError(
          "the source order is no longer approved — resolve it before voiding",
        );
      }
      // Restoring the counter must neither drive fulfilled negative nor cut
      // into already-billed quantities; both are decided in storage arithmetic.
      const cover = (
        await tx.execute<{ restorable: boolean; billed_block: boolean }>(
          sql`
        select (quantity_fulfilled - ${source.void_quantity}::numeric) >= 0 as restorable,
               (quantity_fulfilled - ${source.void_quantity}::numeric) < quantity_billed as billed_block
          from document_lines where id = ${source.source_line_id} and org_id = ${input.orgId}
      `,
          "objects",
        )
      )[0]!;
      if (!cover.restorable) {
        throw new DocumentVoidError("voiding would drive a source line below zero fulfilled");
      }
      if (cover.billed_block) {
        throw new DocumentVoidError(
          "this document's quantities are already billed — reverse the invoice or bill first",
        );
      }
    }
    // Before-evidence for every source order whose counters are about to
    // move: captured under the locks above, before any counter or movement
    // write in this unwind.
    const beforeSnapshots = new Map<string, TransactionAuditSnapshot>();
    for (const order of orders) {
      const snapshot = await captureTransactionAuditSnapshot(tx, order.id, input.orgId);
      if (!snapshot)
        throw new DocumentVoidError("a source order disappeared while it was being voided");
      beforeSnapshots.set(order.id, snapshot);
    }
    const liveMovements = await tx.execute<{ id: string }>(
      sql`
      select movement.id
        from inventory_movements movement
        join document_lines line
          on line.id = movement.document_line_id and line.org_id = movement.org_id
       where movement.org_id = ${input.orgId}
         and line.document_id = ${input.voidDocumentId}
         and movement.kind = ${movementKind}
         and movement.status = 'posted'
         and not exists (
           select 1 from inventory_movements reversal
            where reversal.org_id = movement.org_id
              and reversal.reverses_movement_id = movement.id
         )
       order by movement.id
       for update of movement
    `,
      "objects",
    );
    if (input.voidKind === "sales_fulfillment") {
      for (const movement of liveMovements) {
        const returned = await postedReturnQuantity(tx, input.orgId, {
          returnKind: "receipt",
          evidenceKey: "sourceIssueMovementId",
          sourceMovementId: movement.id,
        });
        if (toUnits(returned) > 0n) {
          throw new DocumentVoidError(
            "this shipment has customer-credit returns; reverse those credits before voiding the shipment",
          );
        }
      }
    }
    for (const movement of liveMovements) {
      try {
        await reverseInventoryMovement(input.orgId, input.actorId, {
          movementId: movement.id,
          reversalDate: input.reversalDate,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof DownstreamConsumptionError && input.voidKind === "purchase_receipt") {
          throw await receiptConsumptionRefusal(tx, input.orgId, input.voidDocumentId);
        }
        if (error instanceof InventoryError) {
          throw new DocumentVoidError(`this document cannot be voided yet — ${error.message}`);
        }
        throw error;
      }
      // A line shipped from another entity's stock also reverses its
      // intercompany cross-charge, so neither entity keeps half of the sale.
      if (
        input.voidKind === "sales_fulfillment" &&
        (await crossSubsidiaryShipment(tx, input.orgId, movement.id))
      ) {
        const handler = crossSubsidiaryFulfillmentHandler();
        if (!handler)
          throw new DocumentVoidError(
            "this shipment was fulfilled by another subsidiary and cannot be voided in this installation",
          );
        await handler.voided(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          issueMovementId: movement.id,
          reversalDate: input.reversalDate,
          reason: input.reason,
        });
      }
    }
    // Approved lines are storage-immutable (migration 0034): restoring the
    // fulfilled counter is operational reconciliation state, not a
    // commercial edit. Reopen each source header while its counters restore
    // (the established order-cycle pattern), then restore approved status.
    for (const order of orders) {
      const reopened = (
        await tx.execute<{ id: string }>(
          sql`
        update documents
           set status = 'draft', updated_by = ${input.actorId}
         where id = ${order.id} and org_id = ${input.orgId} and status = 'approved'
        returning id
      `,
          "objects",
        )
      )[0];
      if (!reopened)
        throw new DocumentVoidError("the source order changed while it was being voided");
      for (const source of sources.filter(
        (row) => orderByLine.get(row.source_line_id)!.id === order.id,
      )) {
        const restored = (
          await tx.execute<{ id: string }>(
            sql`
          update document_lines
             set quantity_fulfilled = quantity_fulfilled - ${source.void_quantity}::numeric,
                 updated_by = ${input.actorId}
           where id = ${source.source_line_id} and org_id = ${input.orgId}
             and quantity_fulfilled - ${source.void_quantity}::numeric >= 0
          returning id
        `,
            "objects",
          )
        )[0];
        if (!restored)
          throw new DocumentVoidError("a source order line changed while it was being voided");
      }
      const restored = (
        await tx.execute<{ id: string }>(
          sql`
        update documents
           set status = 'approved', updated_by = ${input.actorId}
         where id = ${order.id} and org_id = ${input.orgId} and status = 'draft'
        returning id
      `,
          "objects",
        )
      )[0];
      if (!restored)
        throw new DocumentVoidError("the source order changed while it was being voided");
    }
    // After-evidence pairs each source order's before snapshot: the void's
    // reason and actor travel on the envelope like the shipment's own.
    for (const order of orders) {
      const after = await captureTransactionAuditSnapshot(tx, order.id, input.orgId);
      await recordTransactionAudit(tx, {
        orgId: input.orgId,
        documentId: order.id,
        action: "update",
        actorId: input.actorId,
        source: "controlled_void",
        reason: input.reason,
        before: beforeSnapshots.get(order.id)!,
        after,
      });
    }
  }
}
