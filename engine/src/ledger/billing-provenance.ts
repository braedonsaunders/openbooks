import { sql } from "drizzle-orm";
import { lineRequiresReceipt } from "../records/stock-receipt.ts";
import { type SqlExecutor } from "../platform/db.ts";
import { laterProgressApplicationNumbers, laterProgressApplicationsRefusal } from "../projects/construction-billing.ts";
import { laterVendorApplicationNumbers, laterVendorApplicationsRefusal } from "../projects/subcontracts.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";

/**
 * A billing release refused because later draws build on the billed draw.
 * Void and delete callers translate it into their own refusal type so the
 * named remedy reaches the operator as a refusal, not a server error.
 */
export class BillingReleaseRefusedError extends Error {}

/**
 * Refuse releasing a progress draw's invoice (which returns the draw to
 * approved, from where it can be voided) while a later non-void draw exists on
 * the same project. Each later draw froze this draw's billed work into its
 * previous-completed basis when it was created; un-billing this draw underneath
 * it would leave that work counted as billed by a draw that no longer bills it.
 * Locks the draw rows, then the project row — the order invoice generation
 * uses, and the project lock application creation takes — so no later draw can
 * be created between this check and the release.
 */
async function assertCustomerDrawReleasable(tx: SqlExecutor, orgId: string, documentId: string): Promise<void> {
  const draws = (await tx.execute<{ project_id: string; application_number: number }>(sql`
    select project_id, application_number from pay_applications
     where org_id = ${orgId} and invoice_document_id = ${documentId}
       and kind = 'progress' and status in ('invoiced', 'posted')
     order by application_number
     for update
  `)).rows;
  for (const draw of draws) {
    await tx.execute(sql`select 1 from projects where org_id = ${orgId} and id = ${draw.project_id} for update`);
    const later = await laterProgressApplicationNumbers(tx, orgId, draw.project_id, Number(draw.application_number));
    if (later.length) {
      throw new BillingReleaseRefusedError(
        laterProgressApplicationsRefusal(Number(draw.application_number), later, "return to approved"),
      );
    }
  }
}

/** Vendor-side counterpart: a billed subcontract draw cannot return to
 * approved while a later non-void draw on the same subcontract carries its
 * earned-to-date forward. Draw rows, then the subcontract row. */
async function assertVendorDrawReleasable(tx: SqlExecutor, orgId: string, documentId: string): Promise<void> {
  const draws = (await tx.execute<{ subcontract_id: string; application_number: number }>(sql`
    select subcontract_id, application_number from vendor_pay_applications
     where org_id = ${orgId} and vendor_bill_document_id = ${documentId} and status = 'billed'
     order by application_number
     for update
  `)).rows;
  for (const draw of draws) {
    await tx.execute(sql`select 1 from subcontracts where org_id = ${orgId} and id = ${draw.subcontract_id} for update`);
    const later = await laterVendorApplicationNumbers(tx, orgId, draw.subcontract_id, Number(draw.application_number));
    if (later.length) {
      throw new BillingReleaseRefusedError(
        laterVendorApplicationsRefusal(Number(draw.application_number), later, "return to approved"),
      );
    }
  }
}

/**
 * Refuse a void or delete whose billing release would return a draw to
 * approved underneath a later draw. Void and delete call this before any
 * effect so the refusal names the later draws; the release functions below
 * repeat it under their own locks as the backstop.
 */
export async function assertBillingReleasable(tx: SqlExecutor, orgId: string, documentId: string): Promise<void> {
  await assertCustomerDrawReleasable(tx, orgId, documentId);
  await assertVendorDrawReleasable(tx, orgId, documentId);
}

/**
 * Customer invoices that currently bill this document's cost lines: every
 * non-voided invoice holding a line that a source line's billed_by_line_id
 * points at. A cost source billed this way keeps its cost until the invoice
 * lets it go; voiding or deleting the invoice releases the link.
 */
export async function liveInvoicesBillingDocument(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<string[]> {
  return (await runner.execute<{ document_number: string }>(sql`
    select distinct invoice.document_number
      from document_lines source
      join document_lines billed on billed.org_id = source.org_id and billed.id = source.billed_by_line_id
      join documents invoice on invoice.org_id = billed.org_id and invoice.id = billed.document_id
     where source.org_id = ${orgId} and source.document_id = ${documentId}
       -- Live entries only: a voided invoice has released what it billed.
       and invoice.status <> 'voided'
     order by invoice.document_number
  `)).rows.map((row) => row.document_number);
}

/** The operator remedy for voiding a cost that an invoice still bills. */
export function billedCostSourceRefusal(invoiceNumbers: readonly string[]): string {
  return `This cost is billed on invoice ${invoiceNumbers.join(", ")}; void or delete that invoice first`;
}

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
  await assertCustomerDrawReleasable(tx, orgId, documentId);
  const retainer = (await tx.execute<{
    id: string;
    state: string;
    obligation_id: string | null;
    invoice_document_id: string;
  }>(sql`
    select id, state, obligation_id, invoice_document_id
      from res_retainers
     where org_id = ${orgId} and invoice_document_id = ${documentId}
     for update
  `)).rows[0];
  if (retainer) {
    const postedDrawdown = (await tx.execute<{ id: string }>(sql`
      select id from res_retainer_drawdowns
       where org_id = ${orgId} and retainer_id = ${retainer.id} and state = 'posted'
       limit 1
    `)).rows[0];
    if (postedDrawdown) throw new Error("retainer invoice provenance cannot be released while a drawdown is posted");
    const nextState = retainer.state === "active" ? "draft" : retainer.state;
    const released = await tx.execute<{ id: string }>(sql`
      update res_retainers
         set invoice_document_id = null, obligation_id = null, state = ${nextState},
             updated_at = now(), updated_by = ${audit.actorId}
       where org_id = ${orgId} and id = ${retainer.id}
         and invoice_document_id = ${documentId}
       returning id
    `);
    if ((released.rowCount ?? 0) !== 1 || released.rows.length !== 1) {
      throw new Error("retainer invoice provenance release did not update exactly one row");
    }
    const evidence = await tx.execute<{ row_id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'res_retainers', ${retainer.id}, 'update',
        ${JSON.stringify({
          before: { invoiceDocumentId: retainer.invoice_document_id, obligationId: retainer.obligation_id, state: retainer.state },
          after: { invoiceDocumentId: null, obligationId: null, state: nextState },
          reason: audit.reason,
        })}::jsonb, ${audit.actorId})
      returning row_id
    `);
    if ((evidence.rowCount ?? 0) !== 1 || evidence.rows.length !== 1) {
      throw new Error("retainer invoice provenance audit did not write exactly one row");
    }
  }

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
      with source as (
        select id, invoiced_by_line_id, billing_status
          from time_entries
         where org_id = ${orgId} and invoiced_by_line_id = any(${idArr}::uuid[])
         for update
      ), released as (
        update time_entries entry
           set invoiced_by_line_id = null, billing_status = 'unbilled', updated_at = now(), updated_by = ${audit.actorId}
          from source
         where entry.org_id = ${orgId} and entry.id = source.id
        returning entry.id, source.invoiced_by_line_id, source.billing_status
      )
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      select ${orgId}, 'time_entries', id, 'billing_released',
        jsonb_build_object(
          'before', jsonb_build_object('invoicedByLineId', invoiced_by_line_id, 'billingStatus', billing_status),
          'after', jsonb_build_object('invoicedByLineId', null, 'billingStatus', 'unbilled'),
          'reason', ${audit.reason}::text), ${audit.actorId}::uuid
        from released
    `);
    // Billed source lines sit on approved or posted documents, whose lines
    // the immutability guard freezes. Clearing the billed-link is provenance
    // metadata, not a financial edit, so it uses the same paired
    // transaction-local authority the invoice generator uses to set it, and
    // clears it again immediately.
    await tx.execute(sql`set local openbooks.migration = on`);
    await tx.execute(sql`set local openbooks.amend = on`);
    await tx.execute(sql`
      with source as (
        select id, billed_by_line_id
          from document_lines
         where org_id = ${orgId} and billed_by_line_id = any(${idArr}::uuid[])
         for update
      ), released as (
        update document_lines line
           set billed_by_line_id = null, updated_at = now(), updated_by = ${audit.actorId}
          from source
         where line.org_id = ${orgId} and line.id = source.id
        returning line.id, source.billed_by_line_id
      )
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      select ${orgId}, 'document_lines', id, 'billing_released',
        jsonb_build_object(
          'before', jsonb_build_object('billedByLineId', billed_by_line_id),
          'after', jsonb_build_object('billedByLineId', null),
          'reason', ${audit.reason}::text), ${audit.actorId}::uuid
        from released
    `);
    await tx.execute(sql`set local openbooks.migration = off`);
    await tx.execute(sql`set local openbooks.amend = off`);
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
  // Progress applications retain their line basis and can regenerate (the
  // check at the top refused if a later draw builds on one). A release
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
 *
 * The release carries the same audit evidence as the customer-side
 * counterpart: the void/delete actor, the reason, and the before/after
 * status and bill link on an `audit_log` row in the caller's transaction,
 * so the application's return to billable is attributable instead of a
 * silent status flip.
 */
export async function releaseVendorBillProvenance(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
  audit: { actorId: string | null; reason: string },
): Promise<void> {
  await assertVendorDrawReleasable(tx, orgId, documentId);
  await tx.execute(sql`
    with source as (
      select id, status from vendor_pay_applications
       where org_id = ${orgId} and vendor_bill_document_id = ${documentId} and status = 'billed'
       for update
    ), released as (
      update vendor_pay_applications vpa
         set status = 'approved', vendor_bill_document_id = null,
             updated_at = now(), updated_by = ${audit.actorId}
        from source where vpa.id = source.id and vpa.org_id = ${orgId}
      returning vpa.id, source.status as previous_status
    )
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    select ${orgId}, 'vendor_pay_applications', id, 'billing_released',
      jsonb_build_object(
        'before', jsonb_build_object('status', previous_status, 'vendor_bill_document_id', ${documentId}::text),
        'after', jsonb_build_object('status', 'approved', 'vendor_bill_document_id', null),
        'reason', ${audit.reason}::text), ${audit.actorId}::uuid
    from released
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
  // Discover the candidate source headers WITHOUT taking line locks. This
  // release must take its locks in the same header-before-lines order
  // convertOrder uses (source header FOR UPDATE, then source lines
  // FOR UPDATE OF dl): taking the source line locks first deadlocks
  // against a concurrent conversion of the same order — the converter
  // holds the header and waits on the lines while this release holds
  // the lines and waits on the header (SQLSTATE 40P01). Nothing read
  // here is trusted; every property is re-validated under the locks
  // below.
  const discovered = (await tx.execute<{ id: string; document_id: string }>(sql`
    select l.id, l.document_id
      from document_lines l
      join documents d on d.id = l.document_id and d.org_id = l.org_id
     where l.org_id = ${orgId} and l.id = any(${idArr}::uuid[])
  `)).rows;
  if (discovered.length !== byLine.size) {
    throw new Error("a source order line for this document is missing — reconcile it before voiding or deleting");
  }
  const candidateDocIds = [...new Set(discovered.map((row) => row.document_id))].sort();

  // Lock the source headers in canonical id order before their lines (the
  // order-cycle lock order), then restore each line under the same ceiling
  // rules the advance faced.
  const headers = (await tx.execute<{ id: string; status: string; document_number: string }>(sql`
    select id, status, document_number from documents
     where org_id = ${orgId} and id = any(${`{${candidateDocIds.join(",")}}`}::uuid[])
     order by id
     for update
  `)).rows;
  if (headers.length !== candidateDocIds.length) {
    throw new Error("a source order for this document is missing — reconcile it before voiding or deleting");
  }
  // Re-read and lock the actual source lines UNDER the held header locks.
  // The discovery above ran unlocked, so a line that moved to an order
  // whose header is not held here refuses instead of restoring against
  // an unlocked source.
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
  const heldHeaderIds = new Set(headers.map((header) => header.id));
  for (const source of sources) {
    if (!heldHeaderIds.has(source.document_id)) {
      throw new Error("a source order line moved while it was being voided or deleted — reconcile it before voiding or deleting");
    }
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

  // Headers are already locked above (before the lines); re-check their
  // lifecycle state here, after the provenance edge validation, so a source
  // that left the draft/approved lifecycle refuses with its number named.
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
