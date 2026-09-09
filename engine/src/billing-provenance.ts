import { sql } from "drizzle-orm";
import { type SqlExecutor } from "./db.ts";

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
