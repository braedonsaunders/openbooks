import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { SubmitError, submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import { ExpenseValidationError } from "@openbooks/engine/records/expense-validation";
import {
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from "@openbooks/engine/records/control-accounts";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { PostingError } from "@openbooks/engine/journal/contracts";
import {
  can,
  getAuthz,
  guardSubsidiaryScope,
  subsidiaryScopeAllows,
  type Authz,
} from "../../../../lib/authz";
import {
  DocumentEditError,
  requireDocumentEditRevision,
} from "@openbooks/engine/records/document-edit-policy";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { ApprovalRoutingError } from "../../../../lib/approval-routing-error";
import { notFound } from "@/lib/api/responses";
import {
  ALL_EXPENSE_REPORTS,
  expenseAccessAllows,
  expenseAccessForScope,
  expenseGrantScope,
  type ExpenseAccess,
} from "@openbooks/engine/records/expense-access";
const POSTBodySchema1 = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), documentId: z.string() }),
  z.object({ action: z.literal("post"), documentId: z.string() }),
  z.object({
    action: z.literal("recall"),
    documentId: z.string(),
    expectedUpdatedAt: z.union([z.string(), z.null()]).optional(),
  }),
]);

export const runtime = "nodejs";

/**
 * Expense report lifecycle: draft → submit (Flows approval) → approved → post.
 * Per-action permission gates: submit = expenses.create (or expenses.self on
 * the caller's own report), post = ap.post, recall = the submit grant plus
 * submitter-or-admin on the report.
 * Approval decisions are owned by the Flows engine (via the /inbox worklist
 * and the record flyout → /api/flows/gates/decide), not this route.
 */

/**
 * The document must be an expense report in the caller's org AND inside the
 * caller's subsidiary scope — submit and post both resolve through here, so a
 * restricted caller can never route an out-of-scope report to the GL.
 */
/**
 * Whose reports the caller submits and recalls: everyone's under
 * expenses.create, only their own under expenses.self. Null without either.
 */
async function submitAccess(authz: Authz): Promise<ExpenseAccess | null> {
  const scope = expenseGrantScope((permission) => can(authz, permission), "edit");
  return scope === null ? null : expenseAccessForScope(db, authz.user.orgId, authz.user.id, scope);
}

async function expenseReport(
  id: string,
  authz: Authz,
  access: ExpenseAccess = ALL_EXPENSE_REPORTS,
) {
  // A malformed id would surface as a Postgres uuid throw and a raw 500;
  // resolve it through the same not-found contract as an unknown id.
  if (!isUuid(id)) return null;
  const r = await db.execute<{
    id: string;
    status: string;
    subsidiaryId: string | null;
    partyId: string | null;
  }>(
    sql`select id, status, subsidiary_id as "subsidiaryId", party_id as "partyId" from documents where id = ${id} and kind = 'expense_report' and org_id = ${authz.user.orgId}`,
    "objects",
  );
  const row = r[0];
  if (!row || !expenseAccessAllows(access, row.partyId)) return null;
  return guardSubsidiaryScope(authz, row.subsidiaryId) ? null : row;
}

/**
 * Locked recheck for the submit/post/recall writes. The expenseReport probe
 * above can authorize report A while a concurrent A→B rehome lands before
 * the write commits; this runs under the document row lock inside the write
 * transaction, so the verdict sees the latest committed subsidiary and the
 * rehome blocks until the write commits.
 */
async function lockedExpenseInScope(
  documentId: string,
  authz: Authz,
  access: ExpenseAccess = ALL_EXPENSE_REPORTS,
): Promise<boolean> {
  if (!isUuid(documentId)) return false;
  const locked = (
    await db.execute<{ subsidiaryId: string | null; partyId: string | null }>(
      sql`select subsidiary_id as "subsidiaryId", party_id as "partyId" from documents
         where id = ${documentId} and kind = 'expense_report' and org_id = ${authz.user.orgId}
         for update`,
      "objects",
    )
  )[0];
  return (
    !!locked &&
    subsidiaryScopeAllows(authz.allowedSubsidiaryIds, locked.subsidiaryId) &&
    expenseAccessAllows(access, locked.partyId)
  );
}

/**
 * Recall a submitted or approved-but-unposted expense report to draft,
 * cancelling its open approval gates and runs. Decided gates stand as
 * history; only open ('pending'/'escalated') gates and live
 * ('running'/'waiting') runs are cancelled, so a concurrent approver either
 * wins first (their decision persists as evidence) or fails closed on the
 * cancelled gate ("already resolved"). Only the submitter (or document
 * author for legacy rows) or an org admin may recall.
 */
async function recallExpenseReport(input: {
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
    // The document author recalls only legacy rows that were never submitted
    // through this flow (no recorded submitter). Once a submitter exists, the
    // creator — who may be a different person (e.g. an assistant who drafted
    // for someone else) — must not be able to pull another user's submission
    // back to draft.
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

export const POST = defineRoute({
  public: "session",
  body: POSTBodySchema1,
  handler: async ({ request: _req, body: routeBody }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const user = authz.user;
    if (!(await isFeatureEnabled(user.orgId, "expenses"))) {
      return notFound("record");
    }

    const body = routeBody as {
      action: "submit" | "post" | "recall";
      documentId?: string;
      expectedUpdatedAt?: string;
    };
    try {
      switch (body.action) {
        case "submit": {
          const access = await submitAccess(authz);
          if (!access) {
            return NextResponse.json(
              { error: "missing permission: expenses.create" },
              { status: 403 },
            );
          }
          if (!body.documentId || !(await expenseReport(body.documentId, authz, access))) {
            return notFound("record");
          }
          const documentId: string = body.documentId;
          // The submission runs in this transaction so a refused routing throws
          // inside it: without the wrapper the submission's own transaction
          // would commit its before_submit script effects before the 422.
          // The catch below answers the same 422 after the rollback.
          // The scope is rechecked under the document lock first (the inner
          // submit joins this transaction): a rehome that lands after the
          // expenseReport probe blocks here instead of riding the submit.
          const submission = await withOrgTransaction(user.orgId, async () => {
            if (!(await lockedExpenseInScope(documentId, authz, access))) return null;
            const inner = await submitAndReleaseIfUngated("expense_report", documentId, user.id);
            if (inner.flowError) {
              throw new ApprovalRoutingError(inner.flowError);
            }
            return inner;
          });
          if (!submission) return notFound("record");
          return NextResponse.json({
            ok: true,
            requestId: submission.runId,
            autoApproved: submission.autoApproved,
          });
        }
        case "post": {
          if (!can(authz, "ap.post")) {
            return NextResponse.json({ error: "missing permission: ap.post" }, { status: 403 });
          }
          if (!body.documentId) {
            return notFound("record");
          }
          const expense = await expenseReport(body.documentId, authz);
          if (!expense) return notFound("record");
          if (expense.status !== "approved") {
            return NextResponse.json(
              {
                error: `expense report is ${expense.status}; only an approved report can be posted`,
              },
              { status: 422 },
            );
          }
          const deps = { control: await loadRequiredControlAccounts(user.orgId) };
          const documentId: string = body.documentId;
          // Post joins this transaction: the scope is rechecked under the
          // document lock first, so a rehome that lands after the
          // expenseReport probe blocks here instead of riding the post.
          const entryId = await withOrgTransaction(user.orgId, async () => {
            if (!(await lockedExpenseInScope(documentId, authz))) return null;
            return postDocument(documentId, deps, {
              audit: { actorId: user.id, source: "ui" },
            });
          });
          if (!entryId) return notFound("record");
          return NextResponse.json({ ok: true, entryId });
        }
        case "recall": {
          const access = await submitAccess(authz);
          if (!access) {
            return NextResponse.json(
              { error: "missing permission: expenses.create" },
              { status: 403 },
            );
          }
          if (!body.documentId || !(await expenseReport(body.documentId, authz, access))) {
            return notFound("record");
          }
          try {
            const outcome = await recallExpenseReport({
              documentId: body.documentId,
              orgId: user.orgId,
              actorId: user.id,
              expectedUpdatedAt: body.expectedUpdatedAt,
              isAdmin: user.isSuperAdmin || user.roles.some((role) => role.key === "admin"),
              allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
              access,
            });
            return NextResponse.json({ ok: true, ...outcome });
          } catch (e) {
            // A rehome that lands between the probe and the locked recheck
            // answers the same hidden not-found as the probe itself.
            if (e instanceof DocumentEditError) {
              return e.status === 404 ? notFound("record") : apiErrorResponse(e);
            }
            throw e;
          }
        }
        default:
          return NextResponse.json({ error: "unknown action" }, { status: 400 });
      }
    } catch (e) {
      // Posting refusals (kernel rules or unconfigured org control accounts)
      // and submission lifecycle refusals (a double-clicked or replayed submit
      // on a report that already left draft) are request-state failures, not
      // server defects. Revision-fence refusals carry their own status; the
      // status-less named refusals below travel with safeStatus 422.
      const unprocessable =
        e instanceof PostingError ||
        e instanceof ControlAccountsIncompleteError ||
        e instanceof SubmitError ||
        e instanceof ExpenseValidationError ||
        e instanceof ApprovalRoutingError;
      return apiErrorResponse(e, unprocessable ? { safeStatus: 422 } : {});
    }
  },
});
