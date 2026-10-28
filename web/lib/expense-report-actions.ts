import "server-only";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { UUID_RE, isUuid } from "@openbooks/engine/platform/identifiers";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  resolveDraftSubsidiary,
  ScopeNotFoundError,
  subsidiaryScopeAllows,
} from "@openbooks/engine/organization/scope";
import { SubmitError, submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import { DocumentVoidError } from "@openbooks/engine/ledger/document-void";
import { correctPostedExpenseReport } from "@openbooks/engine/ledger/document-correction-editing";
import {
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from "@openbooks/engine/records/control-accounts";
import { ExpenseValidationError } from "@openbooks/engine/records/expense-validation";
import { allocateDocumentNumber } from "@openbooks/engine/records/numbering";
import { documentCreateContentRefusal } from "@openbooks/engine/records/document-kinds";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { PostingError } from "@openbooks/engine/journal/contracts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "@openbooks/engine/records/transaction-audit";
import {
  DocumentEditError,
  requireDocumentEditRevision,
  runDocumentVersionedTransaction,
  validateCorrectionReason,
} from "@openbooks/engine/records/document-edit-policy";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { deleteDocument, DeleteError } from "@openbooks/engine/ledger/document-delete";
import {
  confirmReceiptLines,
  ReceiptCaptureRefusal,
} from "@openbooks/engine/payables/receipt-capture-service";
import {
  expenseAccessAllows,
  expenseEmployeeForAccess,
  expenseAccessForScope,
  expenseGrantScope,
  ExpenseSelfServiceRefusal,
  ALL_EXPENSE_REPORTS,
  type ExpenseAccess,
} from "@openbooks/engine/records/expense-access";
import { apiErrorResponse } from "./api/error-response";
import { notFound } from "./api/responses";
import { can, guardSubsidiaryScope, type Authz } from "./authz";
import { DocumentCreateConflict } from "./documents";
import { ApprovalRoutingError } from "./approval-routing-error";
import { isFeatureEnabled } from "./features";
import {
  assertReportEmployee,
  type ExpenseCorrectionBody,
  persistExpenseEdit,
  prepareExpenseEdit,
  type ExpenseEditBody,
} from "./expense-edit";
import { expenseReportCurrency, loadExpenseReport } from "./expenses";
import { expenseAccess } from "./expense-access";

const UUID = z.string().regex(UUID_RE);
const DECIMAL = z.string().regex(/^-?\d+(?:\.\d{1,4})?$/);
const nullableId = UUID.nullable();

export const expenseReportLineSchema = z
  .looseObject({
    accountId: UUID.describe("Expense account UUID."),
    amount: DECIMAL.describe("Exact line amount as a decimal string."),
    description: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Optional expense description."),
    quantity: DECIMAL.nullable().optional().describe("Optional exact quantity."),
    unit: z.string().max(50).nullable().optional().describe("Optional quantity unit."),
    unitPrice: DECIMAL.nullable().optional().describe("Optional exact unit price."),
    taxAmount: DECIMAL.nullable().optional().describe("Optional exact tax amount."),
    taxCodeId: nullableId.optional().describe("Optional tax code UUID."),
    taxGroupId: nullableId.optional().describe("Optional tax group UUID."),
    departmentId: nullableId.optional().describe("Optional department UUID."),
    projectId: nullableId.optional().describe("Optional project UUID."),
    locationId: nullableId.optional().describe("Optional location UUID."),
    classId: nullableId.optional().describe("Optional class UUID."),
    amortizationTemplateId: nullableId.optional().describe("Optional amortization template UUID."),
    amortizationStartOn: z
      .string()
      .nullable()
      .optional()
      .describe("Optional amortization start date."),
    amortizationEndOn: z.string().nullable().optional().describe("Optional amortization end date."),
    settlementType: z
      .enum(["out_of_pocket", "company_paid", "personal"])
      .nullable()
      .optional()
      .describe("Who paid this expense."),
    foreignCurrency: z
      .unknown()
      .optional()
      .describe("Optional original-currency details for a foreign-currency expense."),
  })
  .describe(
    "Expense line fields. Additional native line fields remain available for forward compatibility.",
  );

export const expenseReportCreateBodySchema = z.object({
  documentDate: z.string().min(1).describe("Expense report date in YYYY-MM-DD format."),
  memo: z.string().nullable().optional().describe("Optional report memo."),
  partyId: nullableId
    .optional()
    .describe("Employee UUID; self-service callers are restricted to their own employee record."),
  paymentCardId: nullableId.optional().describe("Optional company payment card UUID."),
  extraDims: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional segment dimension values."),
  custom: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional custom field values by field key."),
  lines: z.array(z.looseObject({})).optional().describe("Expense lines to save with the report."),
});

export const expenseReportReceiptLineSchema = z.strictObject({
  captureId: UUID.describe("Receipt capture UUID."),
  lineIndex: z.number().int().min(0).describe("Zero-based expense line index."),
  transactionDate: z.string().describe("Receipt transaction date."),
  merchantName: z.string().describe("Merchant name confirmed by the reviewer."),
  merchantPartyId: UUID.nullable().describe("Merchant party UUID, or null when unmatched."),
});

export const expenseReportUpdateBodySchema = z
  .object({
    documentDate: z.string().optional().describe("Updated report date in YYYY-MM-DD format."),
    expectedUpdatedAt: z
      .string()
      .min(1)
      .optional()
      .describe("Exact revision token from the expense report read."),
    memo: z.string().nullable().optional().describe("Updated report memo."),
    partyId: nullableId.optional().describe("Updated employee UUID."),
    paymentCardId: nullableId.optional().describe("Updated company payment card UUID."),
    extraDims: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Updated segment dimension values."),
    custom: z.record(z.string(), z.unknown()).optional().describe("Updated custom field values."),
    lines: z.array(z.looseObject({})).optional().describe("Replacement expense lines."),
    receiptLines: z
      .array(expenseReportReceiptLineSchema)
      .max(500)
      .optional()
      .describe("Confirmed receipt captures linked to the replacement lines."),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Supply the expense changes to save.",
  });

export const expenseReportDeleteBodySchema = z.object({
  expectedUpdatedAt: z
    .string()
    .min(1)
    .optional()
    .describe("Exact revision token from the expense report read."),
});

export const expenseReportCorrectionBodySchema = z
  .object({
    amendmentReason: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Reason for correcting the posted report."),
    expectedUpdatedAt: z
      .string()
      .min(1)
      .optional()
      .describe("Exact revision token from the posted report read."),
    documentDate: z.string().optional().describe("Replacement report date in YYYY-MM-DD format."),
    memo: z.string().nullable().optional().describe("Replacement report memo."),
    partyId: z.string().nullable().optional().describe("Replacement employee UUID."),
    paymentCardId: z
      .string()
      .nullable()
      .optional()
      .describe("Replacement company payment card UUID."),
    extraDims: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Replacement segment dimension values."),
    custom: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Replacement custom field values."),
    lines: z.array(z.looseObject({})).optional().describe("Replacement expense lines."),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

type ExpenseReportCreateBody = z.infer<typeof expenseReportCreateBodySchema>;
type ExpenseReportUpdateBody = z.infer<typeof expenseReportUpdateBodySchema>;
type ExpenseReportDeleteBody = z.infer<typeof expenseReportDeleteBodySchema>;
type ExpenseReportCorrectionBody = z.infer<typeof expenseReportCorrectionBodySchema>;
type ReceiptLineBody = z.infer<typeof expenseReportReceiptLineSchema>;
type RouteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function malformedId(id: string): NextResponse | null {
  return isUuid(id) ? null : notFound("record");
}

export async function expenseSubmissionAccess(gate: Authz): Promise<ExpenseAccess | null> {
  const scope = expenseGrantScope((permission) => can(gate, permission), "edit");
  return scope === null ? null : expenseAccessForScope(db, gate.user.orgId, gate.user.id, scope);
}

export async function findExpenseReportInScope(
  id: string,
  gate: Authz,
  access: ExpenseAccess = ALL_EXPENSE_REPORTS,
) {
  if (!isUuid(id)) return null;
  const row = (
    await db.execute<{
      id: string;
      status: string;
      subsidiaryId: string | null;
      partyId: string | null;
    }>(
      sql`
      select id, status, subsidiary_id as "subsidiaryId", party_id as "partyId"
        from documents
       where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}
    `,
      "objects",
    )
  )[0];
  if (!row || !expenseAccessAllows(access, row.partyId)) return null;
  return guardSubsidiaryScope(gate, row.subsidiaryId) ? null : row;
}

export async function lockExpenseReportInScope(
  id: string,
  gate: Authz,
  access: ExpenseAccess = ALL_EXPENSE_REPORTS,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const locked = (
    await db.execute<{ subsidiaryId: string | null; partyId: string | null }>(
      sql`
      select subsidiary_id as "subsidiaryId", party_id as "partyId"
        from documents
       where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}
       for update
    `,
      "objects",
    )
  )[0];
  return (
    !!locked &&
    subsidiaryScopeAllows(gate.allowedSubsidiaryIds, locked.subsidiaryId) &&
    expenseAccessAllows(access, locked.partyId)
  );
}

export async function submitExpenseReport(gate: Authz, id: string): Promise<NextResponse> {
  if (!(await isFeatureEnabled(gate.user.orgId, "expenses"))) return notFound("record");
  const access = await expenseSubmissionAccess(gate);
  if (!access) {
    return NextResponse.json({ error: "missing permission: expenses.create" }, { status: 403 });
  }
  if (!(await findExpenseReportInScope(id, gate, access))) return notFound("record");
  try {
    const submission = await withOrgTransaction(gate.user.orgId, async () => {
      if (!(await lockExpenseReportInScope(id, gate, access))) return null;
      const result = await submitAndReleaseIfUngated("expense_report", id, gate.user.id);
      if (result.flowError) throw new ApprovalRoutingError(result.flowError);
      return result;
    });
    if (!submission) return notFound("record");
    return NextResponse.json({
      ok: true,
      requestId: submission.runId,
      autoApproved: submission.autoApproved,
    });
  } catch (error) {
    const unprocessable =
      error instanceof SubmitError ||
      error instanceof ExpenseValidationError ||
      error instanceof ApprovalRoutingError;
    return apiErrorResponse(error, unprocessable ? { safeStatus: 422 } : {});
  }
}

export async function postExpenseReport(
  gate: Authz,
  id: string,
  source: "ui" | "api" | "mcp" | "assistant" = "ui",
): Promise<NextResponse> {
  if (!(await isFeatureEnabled(gate.user.orgId, "expenses"))) return notFound("record");
  if (!can(gate, "ap.post")) {
    return NextResponse.json({ error: "missing permission: ap.post" }, { status: 403 });
  }
  const expense = await findExpenseReportInScope(id, gate);
  if (!expense) return notFound("record");
  if (expense.status !== "approved") {
    return NextResponse.json(
      { error: `expense report is ${expense.status}; only an approved report can be posted` },
      { status: 422 },
    );
  }
  try {
    const deps = { control: await loadRequiredControlAccounts(gate.user.orgId) };
    const entryId = await withOrgTransaction(gate.user.orgId, async () => {
      if (!(await lockExpenseReportInScope(id, gate))) return null;
      return postDocument(id, deps, {
        audit: { actorId: gate.user.id, source },
      });
    });
    if (!entryId) return notFound("record");
    return NextResponse.json({ ok: true, entryId });
  } catch (error) {
    const unprocessable =
      error instanceof PostingError ||
      error instanceof ControlAccountsIncompleteError ||
      error instanceof ExpenseValidationError;
    return apiErrorResponse(error, unprocessable ? { safeStatus: 422 } : {});
  }
}

export async function createExpenseReport(
  gate: Authz,
  routeBody: ExpenseReportCreateBody,
  idempotencyKey: string,
): Promise<NextResponse> {
  const user = gate.user;
  const key = idempotencyKey.trim();
  if (!isUuid(key)) return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  const access = await expenseAccess(gate, "edit");
  if (!access)
    return NextResponse.json({ error: "missing permission: expenses.create" }, { status: 403 });
  const requested = routeBody as ExpenseEditBody;
  let employeeId: string | null | undefined;
  try {
    employeeId = expenseEmployeeForAccess(access, requested.partyId);
  } catch (error) {
    if (error instanceof ExpenseSelfServiceRefusal) return apiErrorResponse(error);
    throw error;
  }
  const body: ExpenseEditBody =
    employeeId === requested.partyId ? requested : { ...requested, partyId: employeeId };
  const resolved = resolveDraftSubsidiary(gate.allowedSubsidiaryIds);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 422 });
  const subsidiaryId = resolved.subsidiaryId;
  const contentRefusal = documentCreateContentRefusal("expense_report", body.lines);
  if (contentRefusal) return NextResponse.json({ error: contentRefusal }, { status: 422 });
  const today = await businessToday(user.orgId);
  const reportCurrency = await expenseReportCurrency(user.orgId);
  if (!reportCurrency) {
    return NextResponse.json(
      {
        error: "The organization has no base currency for its expense reports",
        code: "expense_report_currency_missing",
        remedy:
          "Set the organization base currency under Company Settings before creating expense reports.",
      },
      { status: 422 },
    );
  }
  let prepared: Awaited<ReturnType<typeof prepareExpenseEdit>>;
  try {
    prepared = await prepareExpenseEdit(body, {
      orgId: user.orgId,
      existingCustom: null,
      existingDocumentDate: today,
      existingPaymentCardId: null,
      reportSubsidiaryId: subsidiaryId,
      reportCurrency,
    });
  } catch (error) {
    if (error instanceof DocumentEditError)
      return apiErrorResponse(error, {
        details: error.fieldErrors ? { fieldErrors: error.fieldErrors } : {},
      });
    throw error;
  }
  const match = { kind: "expense_report", body: routeBody };
  let outcome: "created" | "replayed";
  try {
    outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const existing = (
        await tx.execute<{ id: string; sameRequest: boolean }>(
          sql`
          select d.id,
                 coalesce((
                   select (al.changes->'after'->'body') = ${JSON.stringify(routeBody)}::jsonb
                     from audit_log al
                    where al.org_id = d.org_id and al.table_name = 'documents'
                      and al.row_id = d.id and al.action = 'insert'
                    limit 1
                 ), false) as "sameRequest"
            from documents d
           where d.id = ${key} and d.org_id = ${user.orgId}
        `,
          "objects",
        )
      )[0];
      if (existing) {
        if (!existing.sameRequest) throw new DocumentCreateConflict();
        return "replayed";
      }
      const documentNumber = await allocateDocumentNumber(tx, user.orgId, "expense_report", "EXP-");
      const inserted = await tx.execute<{ id: string }>(
        sql`
        insert into documents
          (id, org_id, kind, subsidiary_id, document_number, document_date,
           currency, subtotal, tax_total, total, created_by)
        values (${key}, ${user.orgId}, 'expense_report', ${subsidiaryId}, ${documentNumber},
                ${body.documentDate ?? today}, ${reportCurrency}, '0', '0', '0', ${user.id})
        on conflict (id) do nothing
        returning id
      `,
        "objects",
      );
      if (!inserted[0]) throw new DocumentCreateConflict();
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${user.orgId}, 'documents', ${key}, 'insert',
                ${JSON.stringify({ before: null, after: { ...match, id: key, org_id: user.orgId, document_number: documentNumber, status: "draft" } })}::jsonb,
                ${user.id}, ${key})
      `);
      const before = await captureTransactionAuditSnapshot(tx, key, user.orgId);
      if (!before) throw new Error(`expense report ${key} disappeared during initialization`);
      await assertReportEmployee(tx, {
        orgId: user.orgId,
        employeeId: body.partyId ?? null,
        reportSubsidiaryId: subsidiaryId,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      await persistExpenseEdit(tx, {
        docId: key,
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
      const after = await captureTransactionAuditSnapshot(tx, key, user.orgId);
      if (!after) throw new Error(`expense report ${key} disappeared during creation`);
      await recordTransactionAudit(tx, {
        orgId: user.orgId,
        documentId: key,
        action: "update",
        actorId: user.id,
        source: "ui",
        before,
        after,
      });
      return "created";
    });
  } catch (error) {
    if (error instanceof DocumentCreateConflict)
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
    if (error instanceof DocumentEditError)
      return apiErrorResponse(error, {
        details: error.fieldErrors ? { fieldErrors: error.fieldErrors } : {},
      });
    throw error;
  }
  const report = await loadExpenseReport(key, user.orgId, gate.allowedSubsidiaryIds, access);
  if (!report) return notFound("record");
  return NextResponse.json(report, { status: outcome === "created" ? 201 : 200 });
}

export async function updateExpenseReport(
  gate: Authz,
  id: string,
  routeBody: ExpenseReportUpdateBody,
): Promise<NextResponse> {
  const malformed = malformedId(id);
  if (malformed) return malformed;
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
    sql`
    select status, document_date, subsidiary_id as "subsidiaryId", party_id as "partyId",
           currency, custom, payment_card_id
      from documents
     where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}
  `,
    "objects",
  );
  if (!existing[0] || !expenseAccessAllows(access, existing[0].partyId)) return notFound("record");
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
    body =
      access.scope === "own" && requested.partyId != null
        ? { ...requested, partyId: expenseEmployeeForAccess(access, requested.partyId) }
        : requested;
  } catch (error) {
    if (error instanceof ExpenseSelfServiceRefusal) return apiErrorResponse(error);
    throw error;
  }
  let expectedRevision: string;
  try {
    expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt);
  } catch (error) {
    if (error instanceof DocumentEditError) return apiErrorResponse(error);
    throw error;
  }
  let prepared: Awaited<ReturnType<typeof prepareExpenseEdit>>;
  try {
    prepared = await prepareExpenseEdit(body, {
      orgId: gate.user.orgId,
      existingCustom: existing[0].custom,
      existingDocumentDate: existing[0].document_date,
      existingPaymentCardId: existing[0].payment_card_id,
      reportSubsidiaryId: existing[0].subsidiaryId,
      reportCurrency: existing[0].currency,
    });
  } catch (error) {
    if (error instanceof DocumentEditError)
      return apiErrorResponse(error, {
        details: error.fieldErrors ? { fieldErrors: error.fieldErrors } : {},
      });
    throw error;
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
           where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}
           for update
        `,
            "objects",
          )
        )[0];
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
          orgId: gate.user.orgId,
          employeeId: (body.partyId === undefined ? locked.partyId : body.partyId) ?? null,
          reportSubsidiaryId: locked.subsidiaryId,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        const auditBefore = await captureTransactionAuditSnapshot(tx, id, gate.user.orgId);
        if (!auditBefore) throw new Error(`expense report ${id} disappeared before update`);
        await persistExpenseEdit(tx, {
          docId: id,
          orgId: gate.user.orgId,
          userId: gate.user.id,
          body: {
            partyId: body.partyId,
            paymentCardId: body.paymentCardId,
            documentDate: body.documentDate,
            memo: body.memo,
          },
          prepared,
        });
        const receiptLines = routeBody.receiptLines ?? [];
        if (receiptLines.length > 0) {
          if (!prepared.preparedLines) {
            throw new DocumentEditError(
              422,
              "Receipt lines are confirmed with the report lines — save the lines together with their receipts",
            );
          }
          await confirmReceiptLines(tx, {
            orgId: gate.user.orgId,
            documentId: id,
            reportCurrency: locked.currency,
            actorId: gate.user.id,
            lines: prepared.preparedLines.map((line) => ({
              accountId: line.accountId,
              amount: line.amount,
              taxAmount: line.taxAmount,
              originalCurrency: line.foreign?.currency ?? null,
              originalAmount: line.foreign?.originalAmount ?? null,
              originalTaxAmount: line.foreign?.originalTaxAmount ?? null,
            })),
            confirmations: receiptLines as ReceiptLineBody[],
          });
        }
        const auditAfter = await captureTransactionAuditSnapshot(tx, id, gate.user.orgId);
        if (!auditAfter) throw new Error(`expense report ${id} disappeared during update`);
        await recordTransactionAudit(tx, {
          orgId: gate.user.orgId,
          documentId: id,
          action: "update",
          actorId: gate.user.id,
          source: "ui",
          before: auditBefore,
          after: auditAfter,
        });
      },
    });
  } catch (error) {
    if (error instanceof DocumentEditError)
      return apiErrorResponse(error, {
        details: error.fieldErrors ? { fieldErrors: error.fieldErrors } : {},
      });
    if (error instanceof ReceiptCaptureRefusal) return apiErrorResponse(error);
    throw error;
  }
  const report = await loadExpenseReport(id, gate.user.orgId, gate.allowedSubsidiaryIds, access);
  if (!report) return notFound("record");
  const responseDenied = guardSubsidiaryScope(gate, report.doc.subsidiary_id as string | null);
  if (responseDenied) return responseDenied;
  return NextResponse.json(report);
}

export async function deleteExpenseReport(
  gate: Authz,
  id: string,
  routeBody: ExpenseReportDeleteBody,
): Promise<NextResponse> {
  const malformed = malformedId(id);
  if (malformed) return malformed;
  const access = await expenseAccess(gate, "edit");
  if (!access) return notFound("record");
  const owned = await db.execute<{ subsidiaryId: string | null; partyId: string | null }>(
    sql`
    select subsidiary_id as "subsidiaryId", party_id as "partyId"
      from documents
     where id = ${id} and kind = 'expense_report' and org_id = ${gate.user.orgId}
  `,
    "objects",
  );
  if (!owned[0] || !expenseAccessAllows(access, owned[0].partyId)) return notFound("record");
  const denied = guardSubsidiaryScope(gate, owned[0].subsidiaryId);
  if (denied) return denied;
  let expectedRevision: string;
  try {
    expectedRevision = requireDocumentEditRevision(routeBody.expectedUpdatedAt);
  } catch (error) {
    if (error instanceof DocumentEditError) return apiErrorResponse(error);
    throw error;
  }
  try {
    await deleteDocument(id, gate.user.id, gate.user.orgId, {
      source: "ui",
      expectedUpdatedAt: expectedRevision,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return notFound("record");
    if (error instanceof DeleteError) return apiErrorResponse(error);
    throw error;
  }
}

export async function correctExpenseReport(
  gate: Authz,
  id: string,
  routeBody: ExpenseReportCorrectionBody,
  source: "ui" | "api" | "mcp" | "assistant" = "ui",
): Promise<NextResponse> {
  if (!isUuid(id)) return notFound("record");
  const user = gate.user;
  const found = await db.execute<{
    status: string;
    subsidiaryId: string | null;
  }>(
    sql`
    select status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${id} and kind = 'expense_report' and org_id = ${user.orgId}
  `,
    "objects",
  );
  const sourceDocument = found[0];
  if (!sourceDocument) return notFound("record");
  const denied = guardSubsidiaryScope(gate, sourceDocument.subsidiaryId);
  if (denied) return denied;
  if (!can(gate, "expenses.create")) {
    return NextResponse.json({ error: "missing permission: expenses.create" }, { status: 403 });
  }
  if (!can(gate, "ap.post")) {
    return NextResponse.json({ error: "missing permission: ap.post" }, { status: 403 });
  }
  if (sourceDocument.status !== "posted") {
    return NextResponse.json(
      { error: "only a posted expense report can be corrected" },
      { status: 422 },
    );
  }

  const body = routeBody as ExpenseCorrectionBody;
  try {
    requireDocumentEditRevision(body.expectedUpdatedAt);
    validateCorrectionReason(body.amendmentReason);
  } catch (error) {
    if (error instanceof DocumentEditError) return apiErrorResponse(error);
    throw error;
  }
  try {
    const corrected = await correctPostedExpenseReport(
      {
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        source,
      },
      { documentId: id, correction: body },
    );
    return NextResponse.json(
      {
        ok: true,
        correctionId: corrected.replacement.id,
        correctionNumber: corrected.replacement.documentNumber,
        voidStatus: corrected.voidResult.status,
        requestId: corrected.voidResult.runId,
      },
      { status: corrected.voidResult.status === "pending_approval" ? 202 : 201 },
    );
  } catch (error) {
    if (error instanceof DocumentEditError || error instanceof DocumentVoidError) {
      return apiErrorResponse(error);
    }
    throw error;
  }
}
