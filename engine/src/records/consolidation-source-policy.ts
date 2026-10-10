import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Call inside the mutation transaction. The source invoice lock is shared
 * with consolidation collection and remains held until the command ends.
 * Retained run/link evidence prevents a custom-field edit from releasing an
 * already consolidated charge for a second posting.
 */
export async function consolidationSourceRefusal(
  tx: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<string | null> {
  const source = (await tx.execute<{ consolidation_status: string | null }>(sql`
    select custom->>'consolidationStatus' as consolidation_status
      from documents
     where org_id = ${orgId} and id = ${documentId} and kind = 'customer_invoice'
     for update
  `)).rows[0];
  if (!source) return null;

  const retained = (await tx.execute(sql`
    select 1
      from document_links link
      join consolidation_runs run
        on run.org_id = link.org_id and run.invoice_id = link.to_document_id
     where link.org_id = ${orgId} and link.from_document_id = ${documentId}
       and link.link_type = 'created_from'
     limit 1
  `)).rows.length > 0;
  if (retained || source.consolidation_status === "superseded") {
    return "This source invoice has been consolidated and cannot be edited, submitted or posted separately. Continue with the consolidated invoice; the source charge is retained as billing evidence.";
  }
  if (source.consolidation_status === "pending_consolidation") {
    return "This invoice is held for consolidated billing and cannot be edited, submitted or posted separately. Run its consolidation group to create the payer invoice.";
  }
  return null;
}
