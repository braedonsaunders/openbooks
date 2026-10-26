import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../lib/pdf-templates/catalog";
import { NextResponse } from "next/server";
import { guardPermission, type Authz } from "../../../lib/authz";
import { authorizeExpenses, expenseAccess, expenseAccessAllows } from "../../../lib/expense-access";

/**
 * The printed/emailed record is the disclosure: resolve its subsidiary scope
 * before any template work. Document-backed types live in `documents`
 * (kind-pinned, matching loadDocumentValues); journal entries carry their own
 * subsidiary. Payroll stubs and cheques inherit the original pay-run document
 * entity, never an employee's later party assignment.
 */
export async function loadRecordSubsidiaryScope(
  recordType: string,
  orgId: string,
  id: string,
): Promise<{ subsidiaryId: string | null; partyId?: string | null } | null> {
  if (recordType === "journal_entry") {
    return (
      (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`select subsidiary_id as "subsidiaryId" from journal_entries where id = ${id} and org_id = ${orgId}`,
          "objects",
        )
      )[0] ?? null
    );
  }
  if (recordType === "pay_stub" || recordType === "payroll_cheque") {
    return (
      (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`
        select d.subsidiary_id as "subsidiaryId"
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
          join documents d on d.id = r.document_id and d.org_id = r.org_id and d.kind = 'pay_run'
         where s.id = ${id} and s.org_id = ${orgId}
      `,
          "objects",
        )
      )[0] ?? null
    );
  }
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType];
  if (!meta?.docKind) return { subsidiaryId: null };
  return (
    (
      await db.execute<{ subsidiaryId: string | null; partyId: string | null }>(
        sql`select subsidiary_id as "subsidiaryId", party_id as "partyId" from documents where id = ${id} and kind = ${meta.docKind} and org_id = ${orgId}`,
        "objects",
      )
    )[0] ?? null
  );
}

/**
 * The read gate for one record type's prints: its catalog read grant, or for
 * expense reports also the self-service grant, which the handler then limits
 * to the caller's own report.
 */
export async function guardRecordTypeRead(
  recordType: string,
  readPermission: string,
): Promise<Authz | NextResponse> {
  return recordType === "expense_report"
    ? authorizeExpenses("read")()
    : guardPermission(readPermission);
}

/** Whether a self-service reader reaches this printed record (always true for org-wide grants). */
export async function recordOwnedByReader(
  authz: Authz,
  recordType: string,
  owned: { partyId?: string | null },
): Promise<boolean> {
  if (recordType !== "expense_report") return true;
  const access = await expenseAccess(authz, "read");
  return access !== null && expenseAccessAllows(access, owned.partyId ?? null);
}
