import { sql } from "drizzle-orm";

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
  // deno-lint-ignore no-explicit-any — accepts any drizzle tx/db with .execute
  tx: { execute: (q: any) => Promise<any> },
  orgId: string,
  documentId: string,
): Promise<void> {
  const lineRes = (await tx.execute(sql`
    select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
  `)) as unknown as { rows: { id: string }[] };
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
}
