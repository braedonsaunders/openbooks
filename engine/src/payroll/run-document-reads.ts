import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export type PayrollDocumentScope = {
  subsidiaryId: string | null;
};

export async function payrollRunDocumentScope(
  orgId: string,
  documentId: string,
): Promise<PayrollDocumentScope | undefined> {
  return (
    await db.execute<PayrollDocumentScope>(
      sql`
      select d.subsidiary_id as "subsidiaryId"
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}`,
      "objects",
    )
  )[0];
}

export async function payrollBankFileDocumentScope(
  orgId: string,
  documentId: string,
  fileId: string,
): Promise<PayrollDocumentScope | undefined> {
  return (
    await db.execute<PayrollDocumentScope>(
      sql`
      select d.subsidiary_id as "subsidiaryId"
        from pay_run_bank_files f
        join pay_runs r on r.document_id = f.pay_run_document_id and r.org_id = f.org_id
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where f.org_id = ${orgId} and f.id = ${fileId} and f.pay_run_document_id = ${documentId}`,
      "objects",
    )
  )[0];
}
