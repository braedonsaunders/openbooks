import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { expenseAccessAllows, type ExpenseAccess } from "@openbooks/engine/records/expense-access";
import {
  DocumentEditError,
  requireDocumentEditRevision,
} from "@openbooks/engine/records/document-edit-policy";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { subsidiaryScopeAllows } from "./authz";

/** Return a submitted or approved-but-unposted expense report to draft, preserving resolved gates as history. */
export async function recallExpenseReport(input: {
  documentId: string;
  orgId: string;
  actorId: string;
  expectedUpdatedAt: unknown;
  isAdmin: boolean;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  access: ExpenseAccess;
}): Promise<{ cancelledGates: number; cancelledRuns: number }> {
  const expectedRevision = requireDocumentEditRevision(input.expectedUpdatedAt);
  return withOrgTransaction(input.orgId, async () => {
    const locked = (
      await db.execute<{
        status: string;
        submittedBy: string | null;
        createdBy: string | null;
        voidRequestedAt: string | null;
        subsidiaryId: string | null;
        partyId: string | null;
        revision: string;
      }>(
        sql`
      select status, submitted_by as "submittedBy", created_by as "createdBy",
             void_requested_at as "voidRequestedAt",
             subsidiary_id as "subsidiaryId", party_id as "partyId",
             ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "revision"
        from documents
       where id = ${input.documentId} and kind = 'expense_report' and org_id = ${input.orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (
      !locked ||
      !subsidiaryScopeAllows(input.allowedSubsidiaryIds, locked.subsidiaryId) ||
      !expenseAccessAllows(input.access, locked.partyId)
    ) {
      throw new DocumentEditError(404, "expense report not found");
    }
    if (locked.status !== "pending_approval" && locked.status !== "approved") {
      throw new DocumentEditError(
        422,
        `expense report is ${locked.status}; only a submitted or approved report can be recalled to draft`,
      );
    }
    if (locked.voidRequestedAt) {
      throw new DocumentEditError(
        422,
        "a void is already in flight for this report — complete it first",
      );
    }
    if (expectedRevision !== locked.revision) {
      throw new DocumentEditError(
        409,
        "this document changed after you opened it; reload and review the latest revision",
      );
    }
    const isSubmitter =
      locked.submittedBy === input.actorId ||
      (locked.submittedBy == null && locked.createdBy === input.actorId);
    if (!isSubmitter && !input.isAdmin) {
      throw new DocumentEditError(
        403,
        "only the submitter or an admin can recall this report to draft",
      );
    }
    const gates = await db.execute<{ id: string }>(
      sql`
      update flow_gates
         set status = 'cancelled', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and subject_kind = 'expense_report' and subject_id = ${input.documentId}
         and status in ('pending', 'escalated')
      returning id
    `,
      "objects",
    );
    const runs = await db.execute<{ id: string }>(
      sql`
      update flow_runs
         set status = 'cancelled', finished_at = now(), error = 'recalled to draft',
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and subject_kind = 'expense_report' and subject_id = ${input.documentId}
         and status in ('running', 'waiting')
      returning id
    `,
      "objects",
    );
    await db.execute(sql`
      update documents
         set status = 'draft',
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${input.actorId}
       where id = ${input.documentId} and org_id = ${input.orgId}
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${input.orgId}, 'documents', ${input.documentId}, 'update',
        ${JSON.stringify({
          mode: "approval_recall",
          before: { status: locked.status },
          after: { status: "draft" },
          cancelledGates: gates.length,
          cancelledRuns: runs.length,
        })}::jsonb,
        ${input.actorId}, 'ui'
      )
    `);
    return { cancelledGates: gates.length, cancelledRuns: runs.length };
  });
}
