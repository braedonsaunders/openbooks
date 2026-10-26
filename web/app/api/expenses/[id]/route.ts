import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { deleteDocument, DeleteError } from "@openbooks/engine/ledger/document-delete";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "@openbooks/engine/records/transaction-audit";
import { guardSubsidiaryScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import {
  DocumentEditError,
  requireDocumentEditRevision,
  runDocumentVersionedTransaction,
} from "@openbooks/engine/records/document-edit-policy";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import {
  assertReportEmployee,
  type ExpenseEditBody,
  persistExpenseEdit,
  prepareExpenseEdit,
} from "../../../../lib/expense-edit";
import { loadExpenseReport } from "../../../../lib/expenses";
import { notFound } from "@/lib/api/responses";
import {
  confirmReceiptLines,
  ReceiptCaptureRefusal,
} from "@openbooks/engine/payables/receipt-capture-service";
import { authorizeExpenses, expenseAccess } from "../../../../lib/expense-access";
import {
  expenseAccessAllows,
  expenseEmployeeForAccess,
  ExpenseSelfServiceRefusal,
} from "@openbooks/engine/records/expense-access";
const DELETEBodySchema1 = z.object({
  // An omitted token reaches the named revision refusal below; a supplied
  // token must still be a non-empty string.
  expectedUpdatedAt: z.string().min(1).optional(),
});

const nullableId = uuidString().nullable();
const receiptLineSchema = z.strictObject({
  captureId: uuidString(),
  lineIndex: z.number().int().min(0),
  transactionDate: z.string(),
  merchantName: z.string(),
  merchantPartyId: uuidString().nullable(),
});
type ReceiptLineBody = z.output<typeof receiptLineSchema>;
const PATCHBodySchema1 = z
  .object({
    // The boundary admits the full edit shape and refuses only wrong types;
    // every domain rule (including a malformed documentDate) belongs to
    // prepareExpenseEdit, which refuses by name with the line number. A
    // narrower schema silently drops submitted lines and custom values while
    // still answering 200.
    documentDate: z.string().optional(),
    expectedUpdatedAt: z.string().min(1).optional(),
    memo: z.string().nullable().optional(),
    partyId: nullableId.optional(),
    paymentCardId: nullableId.optional(),
    extraDims: z.record(z.string(), z.unknown()).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
    lines: z.array(z.looseObject({})).optional(),
    // Receipt captures the reviewer confirmed into submitted lines. Each names
    // the zero-based line it backs and the merchant and transaction date the
    // reviewer confirmed; the confirmation commits with the line save.
    receiptLines: z.array(receiptLineSchema).max(500).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Supply the expense changes to save.",
  });

type RouteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const runtime = "nodejs";

/**
 * A path segment that is not a uuid (e.g. /api/expenses/reports, which is
 * not a route) must resolve through the typed not-found contract. Without
 * this the id binds straight into a uuid comparison and PostgreSQL throws
 * 22P02, surfacing as an empty-body 500.
 */
function malformedId(id: string): NextResponse | null {
  return isUuid(id) ? null : notFound("record");
}

export const GET = defineRoute({
  params: z.object({ id: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("read"),
  feature: "expenses",
  handler: async ({ authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    const malformed = malformedId(id);
    if (malformed) return malformed;
    const access = await expenseAccess(gate, "read");
    if (!access) return notFound("record");
    const report = await loadExpenseReport(id, gate.user.orgId, gate.allowedSubsidiaryIds, access);
    if (!report) return notFound("record");
    const denied = guardSubsidiaryScope(gate, report.doc.subsidiary_id as string | null);
    if (denied) return denied;
    return NextResponse.json(report);
  },
});

/**
 * Autosave an expense-report draft. Approval and posted states preserve the
 * submitted evidence; corrections are represented by a separate report.
 *
 * Saves are fenced by the document's exact revision: the caller echoes the
 * `updated_at` token it loaded, and the write happens only when that token
 * still matches the row locked FOR UPDATE inside the same transaction — so
 * two concurrent saves can never silently overwrite one another.
 *
 * Self-service callers save only their own draft, and cannot hand it to
 * another employee.
 */
export const PATCH = defineRoute({
  params: z.object({ id: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  body: PATCHBodySchema1,
  opaque: {
    extraDims: "segment dimensions are validated by name in prepareExpenseEdit",
    custom: "custom values are validated against the live definitions in prepareExpenseEdit",
  },
  handler: async ({ authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const user = gate.user;
    const { id } = await params;
    const malformedPatch = malformedId(id);
    if (malformedPatch) return malformedPatch;
    const access = await expenseAccess(gate, "edit");
    if (!access) return notFound("record");
    const existing = await db.execute<{
      status: string;
      document_date: string;
      subsidiaryId: string | null;
      partyId: string | null;
      currency: string;
      custom: Record<string, unknown> | null;
      payment_card_id: string | null;
    }>(
      sql`select status, document_date, subsidiary_id as "subsidiaryId", party_id as "partyId", currency, custom, payment_card_id from documents where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}`,
      "objects",
    );
    if (!existing[0] || !expenseAccessAllows(access, existing[0].partyId))
      return notFound("record");
    const denied = guardSubsidiaryScope(gate, existing[0].subsidiaryId);
    if (denied) return denied;
    if (existing[0].status !== "draft") {
      return NextResponse.json(
        {
          error: `a ${existing[0].status} expense report cannot be edited — create a correcting report instead`,
        },
        { status: 422 },
      );
    }

    const requested = routeBody as ExpenseEditBody;
    let body: ExpenseEditBody;
    try {
      // A self-service save may restate its own employee but never name another.
      body =
        access.scope === "own" && requested.partyId != null
          ? { ...requested, partyId: expenseEmployeeForAccess(access, requested.partyId) }
          : requested;
    } catch (e) {
      if (e instanceof ExpenseSelfServiceRefusal) return apiErrorResponse(e);
      throw e;
    }
    let expectedRevision: string;
    try {
      expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt);
    } catch (e) {
      if (e instanceof DocumentEditError) {
        return apiErrorResponse(e);
      }
      throw e;
    }
    let prepared: Awaited<ReturnType<typeof prepareExpenseEdit>>;
    try {
      prepared = await prepareExpenseEdit(body, {
        orgId: user.orgId,
        existingCustom: existing[0].custom,
        existingDocumentDate: existing[0].document_date,
        existingPaymentCardId: existing[0].payment_card_id,
        // The report's locked subsidiary: an employee of another legal entity
        // is refused below with the scope-opaque not-found refusal.
        reportSubsidiaryId: existing[0].subsidiaryId,
        reportCurrency: existing[0].currency,
      });
    } catch (e) {
      if (e instanceof DocumentEditError) {
        return apiErrorResponse(e, {
          details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : {},
        });
      }
      throw e;
    }
    try {
      await runDocumentVersionedTransaction<
        RouteTransaction,
        {
          status: string;
          updatedAt: string;
          subsidiaryId: string | null;
          partyId: string | null;
          currency: string;
        },
        void
      >({
        expectedRevision,
        transaction: (work) => db.transaction(work),
        // The row lock and exact revision comparison are the first operations in
        // the write transaction: a concurrent writer cannot slip between the
        // check and the header/line replacement.
        lock: async (tx) => {
          const row = (
            await tx.execute<{
              status: string;
              updatedAt: string;
              subsidiaryId: string | null;
              partyId: string | null;
              currency: string;
            }>(
              sql`
              select status, subsidiary_id as "subsidiaryId", party_id as "partyId", currency,
                     ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt"
                from documents
               where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}
               for update
            `,
              "objects",
            )
          )[0];
          // Scope and ownership precede revision comparison so a rehomed or
          // reassigned document remains indistinguishable from a missing
          // row, even with a stale token.
          return row &&
            !guardSubsidiaryScope(gate, row.subsidiaryId) &&
            expenseAccessAllows(access, row.partyId)
            ? row
            : null;
        },
        mutate: async (tx, locked) => {
          if (locked.status !== "draft") {
            throw new DocumentEditError(
              422,
              `a ${locked.status} expense report cannot be edited — create a correcting report instead`,
            );
          }

          await assertReportEmployee(tx, {
            orgId: user.orgId,
            employeeId: (body.partyId === undefined ? locked.partyId : body.partyId) ?? null,
            reportSubsidiaryId: locked.subsidiaryId,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          });

          const auditBefore = await captureTransactionAuditSnapshot(tx, id, user.orgId);
          if (!auditBefore) throw new Error(`expense report ${id} disappeared before update`);

          await persistExpenseEdit(tx, {
            docId: id,
            orgId: user.orgId,
            userId: user.id,
            body: {
              partyId: body.partyId,
              paymentCardId: body.paymentCardId,
              documentDate: body.documentDate,
              memo: body.memo,
            },
            prepared,
          });

          const receiptLines =
            (routeBody as { receiptLines?: ReceiptLineBody[] }).receiptLines ?? [];
          if (receiptLines.length > 0) {
            if (!prepared.preparedLines) {
              throw new DocumentEditError(
                422,
                "Receipt lines are confirmed with the report lines — save the lines together with their receipts",
              );
            }
            await confirmReceiptLines(tx, {
              orgId: user.orgId,
              documentId: id,
              reportCurrency: locked.currency,
              actorId: user.id,
              lines: prepared.preparedLines.map((line) => ({
                accountId: line.accountId,
                amount: line.amount,
                taxAmount: line.taxAmount,
                originalCurrency: line.foreign?.currency ?? null,
                originalAmount: line.foreign?.originalAmount ?? null,
                originalTaxAmount: line.foreign?.originalTaxAmount ?? null,
              })),
              confirmations: receiptLines,
            });
          }

          const auditAfter = await captureTransactionAuditSnapshot(tx, id, user.orgId);
          if (!auditAfter) throw new Error(`expense report ${id} disappeared during update`);
          await recordTransactionAudit(tx, {
            orgId: user.orgId,
            documentId: id,
            action: "update",
            actorId: user.id,
            source: "ui",
            before: auditBefore,
            after: auditAfter,
          });
        },
      });
    } catch (e) {
      if (e instanceof DocumentEditError) {
        return apiErrorResponse(e, {
          details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : {},
        });
      }
      if (e instanceof ReceiptCaptureRefusal) return apiErrorResponse(e);
      throw e;
    }
    const report = await loadExpenseReport(id, user.orgId, gate.allowedSubsidiaryIds, access);
    if (!report) return notFound("record");
    const responseDenied = guardSubsidiaryScope(gate, report.doc.subsidiary_id as string | null);
    if (responseDenied) return responseDenied;
    return NextResponse.json(report);
  },
});

/**
 * Delete an expense report (guarded: open period, no applied payments, no
 * downstream conversion). Self-service callers delete only their own report.
 */
export const DELETE = defineRoute({
  params: z.object({ id: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  body: DELETEBodySchema1,
  opaque: {
    expectedUpdatedAt: "an omitted token reaches the named revision refusal",
  },
  handler: async ({ authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    const malformedDelete = malformedId(id);
    if (malformedDelete) return malformedDelete;
    const access = await expenseAccess(gate, "edit");
    if (!access) return notFound("record");
    const owned = await db.execute<{ subsidiaryId: string | null; partyId: string | null }>(
      sql`select subsidiary_id as "subsidiaryId", party_id as "partyId" from documents where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}`,
      "objects",
    );
    if (!owned[0] || !expenseAccessAllows(access, owned[0].partyId)) return notFound("record");
    const denied = guardSubsidiaryScope(gate, owned[0].subsidiaryId);
    if (denied) return denied;

    const body = routeBody as { expectedUpdatedAt?: string };
    let expectedRevision: string;
    try {
      expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt);
    } catch (e) {
      if (e instanceof DocumentEditError) {
        return apiErrorResponse(e);
      }
      throw e;
    }
    try {
      await deleteDocument(id, gate.user.id, gate.user.orgId, {
        source: "ui",
        expectedUpdatedAt: expectedRevision,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      if (e instanceof ScopeNotFoundError) return notFound("record");
      // The engine fence carries its own 409; every other refusal stays 422.
      if (e instanceof DeleteError) return apiErrorResponse(e);
      throw e;
    }
  },
});
