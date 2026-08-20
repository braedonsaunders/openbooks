import { sql } from "drizzle-orm";
import { type SqlExecutor } from "./db.ts";

/**
 * Release the billing provenance a project invoice consumed. Called when a
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
): Promise<void> {
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
  // A progress-billing application that produced this invoice is provenance in
  // exactly the same sense as a billing request, and owes the same release.
  //
  // `pay_applications.invoice_document_id` carries no foreign key, so deleting
  // the draft invoice succeeds and leaves the application stranded in
  // 'invoiced': it can no longer be re-invoiced (the generator requires
  // 'approved'), cannot be voided, and — because the cumulative
  // `previous_completed` base counts every application in ('invoiced','posted')
  // — its work-in-place stays permanently consumed. That silently burns
  // billable capacity on the schedule of values with no way back.
  await tx.execute(sql`
    update pay_applications set status = 'approved', invoice_document_id = null, updated_at = now()
     where org_id = ${orgId} and invoice_document_id = ${documentId} and status = 'invoiced'
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
