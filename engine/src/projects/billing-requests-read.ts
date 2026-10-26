import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import type { SqlExecutor } from "../platform/db.ts";

export interface BillingRequestInvoice {
  invoice_document_id: string | null;
  backup_type: string;
}

/** Resolve the generated invoice while preserving project and document scope. */
export async function readBillingRequestInvoice(
  db: SqlExecutor,
  orgId: string,
  requestId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<BillingRequestInvoice | null> {
  const rows = await db.execute<BillingRequestInvoice>(
    sql`
    select br.invoice_document_id, br.backup_type from billing_requests br
      join projects p on p.id = br.project_id and p.org_id = br.org_id
     where br.id = ${requestId} and br.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
       and (br.invoice_document_id is null or exists (
         select 1 from documents d where d.id = br.invoice_document_id and d.org_id = br.org_id
           ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       ))
  `,
    "objects",
  );
  return rows[0] ?? null;
}
