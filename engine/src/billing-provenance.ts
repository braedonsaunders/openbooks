import { sql } from "drizzle-orm";
import { lineRequiresReceipt } from "./ap-capture-service.ts";
import { type SqlExecutor } from "./db.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "./transaction-audit.ts";

/**
 * Release the billing provenance a generated invoice consumed. Called when a
 * generated `customer_invoice` is voided or deleted so its billed time entries /
 * cost lines become billable again and the originating billing request reopens.
 * Idempotent; runs inside the caller's transaction. Without this, voiding or
 * deleting an invoice would strand its time as permanently un-rebillable
 * (the generator only picks time whose billing lifecycle is `unbilled` and
 * cost rows whose billed_by link is NULL).
 *
 * Lives in engine (not web/lib) so every delete/void path can reach it. No-op
 * for non-invoice documents.
 */
export async function releaseBillingProvenance(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  audit: { actorId: string | null; reason: string },
): Promise<void> {
  // Keep source release and its evidence in the caller's controlled void/delete
  // transaction. The historical invoice retains its original schedule IDs;
  // clearing this current reservation permits a corrected invoice exactly once.
  await tx.execute(sql`
    with released as (
      update lease_schedule_lines
         set status = 'scheduled', invoice_document_id = null,
             updated_at = now(), updated_by = ${audit.actorId}
       where org_id = ${orgId} and invoice_document_id = ${documentId}
         and status = 'invoiced'
       returning id
    )
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    select ${orgId}, 'lease_schedule_lines', id, 'billing_released',
      jsonb_build_object(
        'before', jsonb_build_object('status', 'invoiced', 'invoice_document_id', ${documentId}::text),
        'after', jsonb_build_object('status', 'scheduled', 'invoice_document_id', null),
        'reason', ${audit.reason}::text), ${audit.actorId}::uuid
    from released
  `);
  const lineRes = (await tx.execute<{ id: string }>(sql`
    select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
  `));
  const lineIds = lineRes.rows.map((r) => r.id);
  if (lineIds.length > 0) {
    const idArr = `{${lineIds.join(",")}}`;
    await tx.execute(sql`
      update time_entries
         set invoiced_by_line_id = null, billing_status = 'unbilled'
       where org_id = ${orgId}
         and invoiced_by_line_id = any(${idArr}::uuid[])`);
    await tx.execute(sql`update document_lines set billed_by_line_id = null where org_id = ${orgId} and billed_by_line_id = any(${idArr}::uuid[])`);
  }
  await tx.execute(sql`
    update billing_schedules set billing_request_id = null
     where org_id = ${orgId}
       and billing_request_id in (select id from billing_requests where invoice_document_id = ${documentId} and org_id = ${orgId})
  `);
  await tx.execute(sql`
    update billing_requests set status = 'open', invoice_document_id = null
     where org_id = ${orgId} and invoice_document_id = ${documentId}
  `);
  // Progress applications retain their line basis and can regenerate. A release
  // has no progress lines: cancel that reservation with evidence so a fresh
  // release recalculates the current GL capacity instead of reopening an
  // approved application that can never bill. Preserve the original row.
  await tx.execute(sql`
    with source as (
      select id, status from pay_applications
       where org_id = ${orgId} and invoice_document_id = ${documentId} and status in ('invoiced', 'posted')
       for update
    ), released as (
      update pay_applications pa
         set status = case when pa.kind = 'retainage_release' then 'void' else 'approved' end,
             invoice_document_id = null, updated_at = now(), updated_by = ${audit.actorId}
        from source where pa.id = source.id and pa.org_id = ${orgId}
      returning pa.id, pa.kind, pa.status, source.status as previous_status
    )
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    select ${orgId}, 'pay_applications', id, 'billing_released',
      jsonb_build_object(
        'kind', kind,
        'before', jsonb_build_object('status', previous_status, 'invoice_document_id', ${documentId}::text),
        'after', jsonb_build_object('status', status, 'invoice_document_id', null),
        'reason', ${audit.reason}::text), ${audit.actorId}::uuid
    from released
  `);
}

/**
 * Vendor-side counterpart: release the subcontract application a vendor bill was
 * generated from. Called when that `vendor_bill` is voided or deleted.
 *
 * Without it the application stays 'billed' pointing at a document that no
 * longer exists, and the re-bill path dereferences that dangling id and throws —
 * the commitment can never be billed again.
 */
export async function releaseVendorBillProvenance(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  await tx.execute(sql`
    update vendor_pay_applications
       set status = 'approved', vendor_bill_document_id = null, updated_at = now()
     where org_id = ${orgId} and vendor_bill_document_id = ${documentId} and status = 'billed'
  `);
}

/**
 * Draft-delete counterpart for vendor retainage releases. A draft
 * `vendor_bill` created by `releaseVendorRetainage` owns a
 * `vendor_retainage_releases` reservation whose
 * `vendor_retainage_bill_org_fk` still points at the bill: deleting the
 * document without releasing the reservation first fails with SQLSTATE
 * 23503. Delete the reservation with full before/after evidence in the
 * caller's transaction so a corrected release can be issued exactly once.
 * Idempotent; a no-op for draft vendor bills that own no reservation.
 *
 * The helper enforces the draft `vendor_bill` boundary itself under a row
 * lock and refuses anything else, so a direct call can never delete posted
 * release provenance even if reused outside the delete path (the delete
 * caller already holds the same lock on a draft). Controlled voids never
 * call this: the voided bill still satisfies the foreign key, the capacity
 * query already excludes voided bills, and the row remains the release's
 * posted-history provenance.
 */
export async function releaseVendorRetainageProvenance(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  audit: { actorId: string | null; reason: string },
): Promise<void> {
  const guarded = (await tx.execute<{ kind: string; status: string }>(sql`
    select kind, status from documents where org_id = ${orgId} and id = ${documentId} for update
  `)).rows[0];
  if (!guarded || guarded.kind !== "vendor_bill" || guarded.status !== "draft") {
    throw new Error("a vendor retainage release reservation can only be released for a draft vendor bill");
  }
  await tx.execute(sql`
    with released as (
      delete from vendor_retainage_releases
       where org_id = ${orgId} and vendor_bill_document_id = ${documentId}
       returning *
    )
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    select ${orgId}, 'vendor_retainage_releases', released.id, 'billing_released',
      jsonb_build_object(
        'before', to_jsonb(released),
        'after', null,
        'reason', ${audit.reason}::text), ${audit.actorId}::uuid
    from released
  `);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Restore the billed-quantity advances a converted or captured child consumed
 * on its source order lines. Called when that child is voided or its draft
 * deleted, so the source remainder becomes convertible/billable again.
 *
 * Every advance path writes its own exact inverse evidence on the child line:
 * `convertOrder` stores `custom.convertedFrom { documentId, lineId, quantity }`
 * (the guarded cover it added to `quantity_billed`); AP capture stores
 * `custom.apCaptureEvidence.purchaseOrderLineId` (the bill added the line
 * quantity, a credit subtracted it — the `purchaseOrderBilledQuantityDelta`
 * sign convention). The restore walks back exactly that advance — never a
 * re-derived share — so partial conversions unwind exactly.
 *
 * Quantities stay in their original decimal form all the way into the guarded
 * storage arithmetic: document quantities are numeric(28,8) and the 4dp money
 * helpers refuse significant digits past 4dp, so parsing them in TypeScript
 * would strand eight-decimal covers.
 *
 * Fail-closed: an unknown provenance shape, a source line that left its order,
 * or a counter that would go negative (or, for an AP credit unwind, exceed the
 * ordered/fulfilled ceilings a fresh bill would face) refuses the whole
 * void/delete with the blocker named. Child lines with no provenance predate
 * this evidence and are left untouched.
 */
export async function releaseConvertedOrderQuantities(
  tx: SqlExecutor,
  orgId: string,
  childDocumentId: string,
  audit: { actorId: string | null; reason: string; source: string },
): Promise<void> {
  const child = (await tx.execute<{ id: string; kind: string }>(sql`
    select id, kind from documents where org_id = ${orgId} and id = ${childDocumentId}
  `)).rows[0];
  if (!child) return;
  const lines = (await tx.execute<{ id: string; quantity: string; custom: unknown }>(sql`
    select id, quantity::text, custom from document_lines
     where org_id = ${orgId} and document_id = ${child.id}
     order by line_number
  `)).rows;

  // direction 'down' walks back an advance that added to the billed counter
  // (a conversion cover or a bill); 'up' walks back one that subtracted (a
  // vendor credit). The magnitude travels verbatim — see the header note.
  type Restore = { sourceLineId: string; claimedDocumentId: string | null; direction: "down" | "up"; magnitude: string };
  const restores: Restore[] = [];
  const QUANTITY_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;
  for (const line of lines) {
    const custom = (line.custom ?? {}) as {
      convertedFrom?: { documentId?: unknown; lineId?: unknown; quantity?: unknown };
      apCaptureEvidence?: { purchaseOrderLineId?: unknown };
    };
    const conv = custom.convertedFrom;
    if (conv && typeof conv === "object") {
      if (typeof conv.lineId !== "string" || !UUID_RE.test(conv.lineId) ||
          typeof conv.quantity !== "string" || !QUANTITY_RE.test(conv.quantity)) {
        throw new Error("a converted line carries unreadable billing provenance — reconcile it before voiding or deleting");
      }
      restores.push({
        sourceLineId: conv.lineId,
        claimedDocumentId: typeof conv.documentId === "string" ? conv.documentId : null,
        // The conversion added this cover to the source billed counter.
        direction: "down",
        magnitude: conv.quantity,
      });
      continue;
    }
    const poLineId = custom.apCaptureEvidence?.purchaseOrderLineId;
    if (typeof poLineId === "string") {
      if (!UUID_RE.test(poLineId) || (child.kind !== "vendor_bill" && child.kind !== "vendor_credit") ||
          !QUANTITY_RE.test(line.quantity)) {
        throw new Error("a captured bill line carries unreadable billing provenance — reconcile it before voiding or deleting");
      }
      restores.push({
        sourceLineId: poLineId,
        claimedDocumentId: null,
        direction: child.kind === "vendor_credit" ? "up" : "down",
        magnitude: line.quantity,
      });
    }
  }
  if (restores.length === 0) return;

  const byLine = new Map<string, Restore[]>();
  for (const restore of restores) {
    const group = byLine.get(restore.sourceLineId) ?? [];
    group.push(restore);
    byLine.set(restore.sourceLineId, group);
  }
  const idArr = `{${[...byLine.keys()].join(",")}}`;
  const sources = (await tx.execute<{
    id: string; document_id: string; document_kind: string; document_status: string;
    quantity: string; quantity_billed: string; quantity_fulfilled: string;
    item_id: string | null; item_kind: string | null;
  }>(sql`
    select l.id, l.document_id, d.kind as document_kind, d.status as document_status,
           l.quantity::text, l.quantity_billed::text, l.quantity_fulfilled::text,
           l.item_id, i.kind as item_kind
      from document_lines l
      join documents d on d.id = l.document_id and d.org_id = l.org_id
      left join items i on i.id = l.item_id and i.org_id = l.org_id
     where l.org_id = ${orgId} and l.id = any(${idArr}::uuid[])
     order by l.document_id, l.id
     for update of l
  `)).rows;
  if (sources.length !== byLine.size) {
    throw new Error("a source order line for this document is missing — reconcile it before voiding or deleting");
  }
  for (const source of sources) {
    if (source.document_kind !== "quote" && source.document_kind !== "sales_order" && source.document_kind !== "purchase_order") {
      throw new Error("a converted line does not point at an order line — reconcile it before voiding or deleting");
    }
    for (const restore of byLine.get(source.id)!) {
      if (restore.claimedDocumentId !== null && restore.claimedDocumentId !== source.document_id) {
        throw new Error("a converted line does not point at its own order — reconcile it before voiding or deleting");
      }
    }
  }

  // The conversion wrote one header-level edge per child; the restore is only
  // valid against the order that edge names. AP capture writes no edge, so
  // its lines are valid against the purchase order that owns the PO line.
  const sourceDocIds = [...new Set(sources.map((source) => source.document_id))].sort();
  for (const sourceDocId of sourceDocIds) {
    const edge = (await tx.execute<{ link_type: string }>(sql`
      select link_type from document_links
       where org_id = ${orgId} and from_document_id = ${sourceDocId} and to_document_id = ${child.id}
       limit 1
    `)).rows[0];
    const edgeOk = edge && (edge.link_type === "bills" || edge.link_type === "created_from");
    const apOnly = sources
      .filter((source) => source.document_id === sourceDocId)
      .every((source) => byLine.get(source.id)!.every((restore) => restore.claimedDocumentId === null));
    if (!edgeOk && !apOnly) {
      throw new Error("this document has no conversion provenance on its source order — reconcile it before voiding or deleting");
    }
  }

  // Lock source headers before their lines (the order-cycle lock order), then
  // restore each line under the same ceiling rules the advance faced.
  const headers = (await tx.execute<{ id: string; status: string; document_number: string }>(sql`
    select id, status, document_number from documents
     where org_id = ${orgId} and id = any(${`{${sourceDocIds.join(",")}}`}::uuid[])
     order by id
     for update
  `)).rows;
  if (headers.length !== sourceDocIds.length) {
    throw new Error("a source order for this document is missing — reconcile it before voiding or deleting");
  }
  for (const header of headers) {
    if (header.status !== "approved" && header.status !== "draft") {
      throw new Error(`${header.document_number} is ${header.status} — resolve it before voiding or deleting this document`);
    }
  }
  const beforeSnapshots = new Map<string, Awaited<ReturnType<typeof captureTransactionAuditSnapshot>>>();
  for (const header of headers) {
    const snapshot = await captureTransactionAuditSnapshot(tx, header.id, orgId);
    if (!snapshot) throw new Error("a source order disappeared while it was being voided or deleted");
    beforeSnapshots.set(header.id, snapshot);
  }
  // Approved lines are storage-immutable (migration 0034): restoring the
  // billed counter is operational reconciliation state, not a commercial
  // edit. Reopen each source header while its counters restore (the
  // established order-cycle pattern), then restore approved status.
  for (const header of headers) {
    let reopened = header.status === "draft";
    if (!reopened) {
      reopened = !!(await tx.execute<{ id: string }>(sql`
        update documents set status = 'draft', updated_at = now(), updated_by = ${audit.actorId}
         where id = ${header.id} and org_id = ${orgId} and status = 'approved'
        returning id
      `)).rows[0];
      if (!reopened) throw new Error("a source order changed while it was being voided or deleted");
    }
    for (const source of sources.filter((row) => row.document_id === header.id)) {
      for (const restore of byLine.get(source.id)!) {
        // A walk-back can only retreat a prior advance; a walk-up (an AP
        // credit unwind) faces the same ceilings a fresh bill would.
        const receiptGoverned = source.item_id !== null && lineRequiresReceipt(source.item_kind ?? null);
        const step = restore.direction === "down"
          ? sql`quantity_billed - ${restore.magnitude}::numeric`
          : sql`quantity_billed + ${restore.magnitude}::numeric`;
        const restored = (await tx.execute<{ id: string }>(sql`
          update document_lines
             set quantity_billed = ${step},
                 updated_at = now(), updated_by = ${audit.actorId}
           where id = ${source.id} and org_id = ${orgId}
             and ${step} >= 0
             ${restore.direction === "down" ? sql`` : sql`and ${step} <= quantity`}
             ${restore.direction === "up" && receiptGoverned ? sql`and ${step} <= quantity_fulfilled` : sql``}
          returning id
        `)).rows[0];
        if (!restored) {
          throw new Error(
            `reversing this document would overdraw the billed quantity on ${header.document_number} — reverse the later billing documents first`,
          );
        }
      }
    }
    if (header.status === "approved") {
      const restored = (await tx.execute<{ id: string }>(sql`
        update documents set status = 'approved', updated_at = now(), updated_by = ${audit.actorId}
         where id = ${header.id} and org_id = ${orgId} and status = 'draft'
        returning id
      `)).rows[0];
      if (!restored) throw new Error("a source order changed while it was being voided or deleted");
    }
  }
  for (const header of headers) {
    const after = await captureTransactionAuditSnapshot(tx, header.id, orgId);
    await recordTransactionAudit(tx, {
      orgId,
      documentId: header.id,
      action: "update",
      actorId: audit.actorId,
      source: audit.source,
      reason: audit.reason,
      before: beforeSnapshots.get(header.id)!,
      after,
    });
  }
}

/** Release a CAM invoice or credit reservation without reopening its frozen pool. */
export async function releaseCamBillingProvenance(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  audit: { actorId: string | null; reason: string },
): Promise<void> {
  // Pool-before-allocation ordering matches billing and controlled reopening.
  await tx.execute(sql`
    select id from cam_pools where org_id=${orgId} and id in (
      select pool_id from cam_allocations where org_id=${orgId} and invoice_document_id=${documentId}
    ) order by id for update
  `);
  await tx.execute(sql`
    with released as (
      update cam_allocations set invoice_document_id=null, updated_at=now(), updated_by=${audit.actorId}
       where org_id=${orgId} and invoice_document_id=${documentId}
       returning id
    )
    insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    select ${orgId},'cam_allocations',id,'billing_released',
      jsonb_build_object(
        'before',jsonb_build_object('invoice_document_id',${documentId}::text),
        'after',jsonb_build_object('invoice_document_id',null),
        'reason',${audit.reason}::text),${audit.actorId}::uuid
    from released
  `);
}
