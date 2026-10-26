import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { resolveDraftSubsidiary } from "@openbooks/engine/organization/scope";
import { allocateDocumentNumber } from "@openbooks/engine/records/numbering";
import { documentCreateContentRefusal } from "@openbooks/engine/records/document-kinds";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "@openbooks/engine/records/transaction-audit";
import { DocumentEditError } from "@openbooks/engine/records/document-edit-policy";
import { isUuid } from "../../../lib/list-params";
import {
  assertReportEmployee,
  type ExpenseEditBody,
  persistExpenseEdit,
  prepareExpenseEdit,
} from "../../../lib/expense-edit";
import { expenseReportCurrency, loadExpenseReport } from "../../../lib/expenses";
import { DocumentCreateConflict } from "../../../lib/documents.ts";
import { notFound } from "@/lib/api/responses";
import { authorizeExpenses, expenseAccess } from "../../../lib/expense-access";
import {
  expenseEmployeeForAccess,
  ExpenseSelfServiceRefusal,
} from "@openbooks/engine/records/expense-access";

const nullableId = uuidString().nullable();
const POSTBodySchema = z.object({
  // Same edit shape as the draft PATCH; prepareExpenseEdit owns every domain
  // rule and refuses by name with the line number.
  documentDate: z.string().min(1),
  memo: z.string().nullable().optional(),
  partyId: nullableId.optional(),
  paymentCardId: nullableId.optional(),
  extraDims: z.record(z.string(), z.unknown()).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  lines: z.array(z.looseObject({})).optional(),
});

export const runtime = "nodejs";

/**
 * Create an expense report on the first explicit Save of the unsaved-create
 * drawer (`?expense=new`). Nothing is numbered or written before this runs:
 * the header, the numbered draft, and the validated lines commit in one
 * transaction, so an invalid Save leaves no report and no number behind.
 *
 * The caller's UUID Idempotency-Key becomes the report id. A retry with the
 * same key and body returns the report the first attempt created; the same
 * key with a different body is a 409 conflict.
 *
 * Self-service callers (expenses.self) create only their own report: the
 * employee is the person linked to their login, whatever the body names.
 */
export const POST = defineRoute({
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  body: POSTBodySchema,
  opaque: {
    extraDims: "segment dimensions are validated by name in prepareExpenseEdit",
    custom: "custom values are validated against the live definitions in prepareExpenseEdit",
  },
  handler: async ({ authz: routeAuthz, body: routeBody, request }) => {
    const gate = routeAuthz;
    const user = gate.user;
    const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(key)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    const access = await expenseAccess(gate, "edit");
    if (!access)
      return NextResponse.json({ error: "missing permission: expenses.create" }, { status: 403 });
    const requested = routeBody as ExpenseEditBody;
    let employeeId: string | null | undefined;
    try {
      employeeId = expenseEmployeeForAccess(access, requested.partyId);
    } catch (e) {
      if (e instanceof ExpenseSelfServiceRefusal) return apiErrorResponse(e);
      throw e;
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

    // Validation runs before any write, so a refused Save allocates nothing.
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
    } catch (e) {
      if (e instanceof DocumentEditError) {
        return apiErrorResponse(e, {
          details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : {},
        });
      }
      throw e;
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
           where d.id = ${key} and d.org_id = ${user.orgId}`,
            "objects",
          )
        )[0];
        if (existing) {
          if (!existing.sameRequest) throw new DocumentCreateConflict();
          return "replayed";
        }

        const documentNumber = await allocateDocumentNumber(
          tx,
          user.orgId,
          "expense_report",
          "EXP-",
        );
        const inserted = await tx.execute<{ id: string }>(
          sql`
          insert into documents
            (id, org_id, kind, subsidiary_id, document_number, document_date,
             currency, subtotal, tax_total, total, created_by)
          values (${key}, ${user.orgId}, 'expense_report', ${subsidiaryId}, ${documentNumber},
                  ${body.documentDate ?? today}, ${reportCurrency}, '0', '0', '0', ${user.id})
          -- A conflicting key is rejected below; it never completes a create.
          on conflict (id) do nothing
          returning id`,
          "objects",
        );
        // A same-key row of this org was found above under the advisory lock,
        // so a conflict here belongs to another org's key: fail closed.
        if (!inserted[0]) throw new DocumentCreateConflict();
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
          values (${user.orgId}, 'documents', ${key}, 'insert',
                  ${JSON.stringify({ before: null, after: { ...match, id: key, org_id: user.orgId, document_number: documentNumber, status: "draft" } })}::jsonb,
                  ${user.id}, ${key})`);

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
    } catch (e) {
      if (e instanceof DocumentCreateConflict) {
        return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
      }
      if (e instanceof DocumentEditError) {
        return apiErrorResponse(e, {
          details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : {},
        });
      }
      throw e;
    }

    const report = await loadExpenseReport(key, user.orgId, gate.allowedSubsidiaryIds, access);
    if (!report) return notFound("record");
    return NextResponse.json(report, { status: outcome === "created" ? 201 : 200 });
  },
});
