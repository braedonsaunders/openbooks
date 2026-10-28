import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  ALL_EXPENSE_REPORTS,
  expenseAccessForScope,
  expenseGrantScope,
} from "@openbooks/engine/records/expense-access";
import { DocumentEditError } from "@openbooks/engine/records/document-edit-policy";
import { isFeatureEnabled } from "../features";
import { can } from "../authz";
import { recallExpenseReport } from "../expense-actions";
import { loadExpenseReport } from "../expenses";
import {
  correctExpenseReport,
  createExpenseReport,
  deleteExpenseReport,
  expenseReportCorrectionBodySchema,
  expenseReportCreateBodySchema,
  expenseReportDeleteBodySchema,
  expenseReportLineSchema,
  expenseReportReceiptLineSchema,
  expenseReportUpdateBodySchema,
  postExpenseReport,
  submitExpenseReport,
  updateExpenseReport,
} from "../expense-report-actions";
import { ApplicationError, forbidden, notFound } from "./errors";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID copied from an expense report read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const REVISION = z
  .string()
  .min(1)
  .max(100)
  .describe("Exact updatedAt revision token copied from the expense report read.");

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const expenseLineInputSchema = expenseReportLineSchema.extend({
  amortizationStartOn: DATE.nullable().optional().describe("Optional amortization start date."),
  amortizationEndOn: DATE.nullable().optional().describe("Optional amortization end date."),
});
const receiptLineInputSchema = expenseReportReceiptLineSchema.extend({
  transactionDate: DATE.describe("Receipt transaction date in YYYY-MM-DD format."),
  merchantName: z.string().max(500).describe("Merchant name confirmed by the reviewer."),
});
const correctionInputSchema = expenseReportCorrectionBodySchema.safeExtend({
  amendmentReason: z
    .string()
    .trim()
    .min(5)
    .max(500)
    .describe("Reason for correcting the posted report."),
  expectedUpdatedAt: REVISION,
  documentDate: DATE.optional(),
  partyId: UUID.nullable().optional().describe("Replacement employee UUID."),
  paymentCardId: UUID.nullable().optional().describe("Replacement company payment card UUID."),
  lines: z
    .array(expenseLineInputSchema)
    .min(1)
    .max(500)
    .optional()
    .describe("Replacement expense lines."),
});

function expenseEditScope(context: ApplicationContext) {
  const scope = expenseGrantScope((permission) => can(context.authz, permission), "edit");
  if (scope === null) throw forbidden("expenses.create");
  assertApplicationPermission(context, scope === "own" ? "expenses.self" : "expenses.create");
  return scope;
}

async function expenseResponse(response: Response, id: string, fallback: string) {
  if (!response.ok) {
    const payload = (await response.json()) as Record<string, unknown>;
    const status = response.status;
    throw new ApplicationError(
      status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 409
            ? "conflict"
            : "invalid_input",
      typeof payload.error === "string" ? payload.error : fallback,
      status,
      payload,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const doc = payload.doc;
  const status =
    doc && typeof doc === "object" && "status" in doc && typeof doc.status === "string"
      ? doc.status
      : "deleted";
  return {
    ok: true,
    ...payload,
    id,
    status,
    href: `/expenses/reports?expense=${encodeURIComponent(id)}`,
  };
}

async function expenseLifecycleResponse(
  context: ApplicationContext,
  response: Response,
  id: string,
  fallback: string,
  access: Awaited<ReturnType<typeof expenseAccessForScope>>,
) {
  if (!response.ok) {
    const payload = (await response.json()) as Record<string, unknown>;
    const status = response.status;
    throw new ApplicationError(
      status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 409
            ? "conflict"
            : "invalid_input",
      typeof payload.error === "string" ? payload.error : fallback,
      status,
      payload,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const report = await loadExpenseReport(
    id,
    context.authz.user.orgId,
    context.authz.allowedSubsidiaryIds,
    access,
  );
  if (!report) throw notFound("expense report");
  return {
    ok: true,
    ...payload,
    ...report,
    id,
    status: report.doc.status,
    href: `/expenses/reports?expense=${encodeURIComponent(id)}`,
  };
}

export const PURCHASING_EXPENSE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "submit_expense_report",
    title: "Submit Expense Report",
    description:
      "Submit an editable draft into the Expenses approval flow; a report may become pending approval or auto-approve. Find draft ids with list_expense_reports or get_expense_report.",
    inputSchema: z.object({ documentId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      expenseGrantScope((permission) => can(authz, permission), "edit") !== null,
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses"))) {
        throw notFound("expense report");
      }
      const scope = expenseEditScope(context);
      const access = await expenseAccessForScope(
        db,
        context.authz.user.orgId,
        context.authz.user.id,
        scope,
      );
      const response = await submitExpenseReport(context.authz, input.documentId);
      return expenseLifecycleResponse(
        context,
        response,
        input.documentId,
        "Expense report submission was refused",
        access,
      );
    },
  }),
  definition({
    name: "post_expense_report",
    title: "Post Expense Report",
    description:
      "Post an approved expense report to the accounting ledger using required control accounts. Find the approved report id with list_expense_reports or get_expense_report.",
    inputSchema: z.object({ documentId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.post"),
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses"))) {
        throw notFound("expense report");
      }
      assertApplicationPermission(context, "ap.post");
      const response = await postExpenseReport(context.authz, input.documentId, context.source);
      return expenseLifecycleResponse(
        context,
        response,
        input.documentId,
        "Expense report posting was refused",
        ALL_EXPENSE_REPORTS,
      );
    },
  }),
  definition({
    name: "correct_expense_report",
    title: "Correct Expense Report",
    description:
      "Create a replacement draft for a posted expense report and request its controlled void atomically. Supply the current report revision and correction reason; find report ids and revisions with list_expense_reports or get_expense_report.",
    inputSchema: correctionInputSchema.extend({
      documentId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "expenses.create") && can(authz, "ap.post"),
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses"))) {
        throw notFound("expense report");
      }
      assertApplicationPermission(context, "expenses.create");
      assertApplicationPermission(context, "ap.post");
      const { documentId, idempotencyKey: _idempotencyKey, ...body } = input;
      const response = await correctExpenseReport(context.authz, documentId, body, context.source);
      if (!response.ok) {
        const payload = (await response.json()) as Record<string, unknown>;
        const status = response.status;
        throw new ApplicationError(
          status === 404
            ? "not_found"
            : status === 403
              ? "forbidden"
              : status === 409
                ? "conflict"
                : "invalid_input",
          typeof payload.error === "string"
            ? payload.error
            : "Expense report correction was refused",
          status,
          payload,
        );
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const correctionId = String(payload.correctionId);
      const report = await loadExpenseReport(
        correctionId,
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
        ALL_EXPENSE_REPORTS,
      );
      if (!report) throw notFound("expense report");
      return {
        ok: true,
        ...payload,
        ...report,
        id: correctionId,
        status: report.doc.status,
        href: `/expenses/reports?expense=${encodeURIComponent(correctionId)}`,
      };
    },
  }),
  definition({
    name: "create_expense_report",
    title: "Create Expense Report",
    description:
      "Create a numbered draft expense report with its employee and exact-decimal lines in one transaction. Find employee, account and card ids with list_records; verify the report with list_expense_reports or get_expense_report.",
    inputSchema: expenseReportCreateBodySchema.extend({
      documentDate: DATE,
      idempotencyKey: IDEMPOTENCY_KEY,
      lines: z
        .array(expenseLineInputSchema)
        .max(500)
        .optional()
        .describe("Expense lines to save with the report."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      expenseGrantScope((permission) => can(authz, permission), "edit") !== null,
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses")))
        throw notFound("expense report");
      const { idempotencyKey, ...body } = input;
      expenseEditScope(context);
      const response = await createExpenseReport(context.authz, body, randomUUID());
      if (!response.ok) {
        const payload = (await response.json()) as Record<string, unknown>;
        const status = response.status;
        throw new ApplicationError(
          status === 404
            ? "not_found"
            : status === 403
              ? "forbidden"
              : status === 409
                ? "conflict"
                : "invalid_input",
          typeof payload.error === "string" ? payload.error : "Expense report creation was refused",
          status,
          payload,
        );
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const reportDoc = payload.doc as Record<string, unknown>;
      const reportId = String(reportDoc.id);
      return {
        ok: true,
        ...payload,
        id: reportId,
        status: reportDoc.status,
        href: `/expenses/reports?expense=${reportId}`,
      };
    },
  }),
  definition({
    name: "update_expense_report",
    title: "Update Expense Report",
    description:
      "Update a draft expense report and its lines using the exact revision token from its read; confirmed receipt links are saved with their lines. Find the report and revision with list_expense_reports or get_expense_report.",
    inputSchema: expenseReportUpdateBodySchema.safeExtend({
      documentDate: DATE.optional(),
      documentId: UUID,
      expectedUpdatedAt: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
      lines: z
        .array(expenseLineInputSchema)
        .max(500)
        .optional()
        .describe("Replacement expense lines."),
      receiptLines: z
        .array(receiptLineInputSchema)
        .max(500)
        .optional()
        .describe("Confirmed receipt captures linked to the replacement lines."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      expenseGrantScope((permission) => can(authz, permission), "edit") !== null,
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses")))
        throw notFound("expense report");
      expenseEditScope(context);
      const { documentId, idempotencyKey: _idempotencyKey, ...body } = input;
      const response = await updateExpenseReport(context.authz, documentId, body);
      return expenseResponse(response, documentId, "Expense report update was refused");
    },
  }),
  definition({
    name: "delete_expense_report",
    title: "Delete Expense Report",
    description:
      "Delete an editable draft expense report only when its exact revision matches and no posting or settlement safeguard blocks removal. Find the report and revision with list_expense_reports or get_expense_report.",
    inputSchema: expenseReportDeleteBodySchema.extend({
      documentId: UUID,
      expectedUpdatedAt: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      expenseGrantScope((permission) => can(authz, permission), "edit") !== null,
    featureKey: "expenses",
    execute: async (context, input) => {
      if (!(await isFeatureEnabled(context.authz.user.orgId, "expenses")))
        throw notFound("expense report");
      expenseEditScope(context);
      const { documentId, expectedUpdatedAt, idempotencyKey: _idempotencyKey } = input;
      const response = await deleteExpenseReport(context.authz, documentId, { expectedUpdatedAt });
      return expenseResponse(response, documentId, "Expense report deletion was refused");
    },
  }),
  definition({
    name: "recall_expense_report",
    title: "Recall Expense Report",
    description:
      "Return a submitted or approved, unposted expense report to draft so its owner can correct and resubmit it. Only its submitter or an admin can recall; find the report and revision with list_expense_reports or get_expense_report.",
    inputSchema: z.object({
      documentId: UUID,
      expectedUpdatedAt: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      expenseGrantScope((permission) => can(authz, permission), "edit") !== null,
    featureKey: "expenses",
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      if (!(await isFeatureEnabled(orgId, "expenses"))) throw notFound("expense report");
      const scope = expenseEditScope(context);
      const access = await expenseAccessForScope(db, orgId, context.authz.user.id, scope);
      try {
        const result = await recallExpenseReport({
          documentId: input.documentId,
          orgId,
          actorId: context.authz.user.id,
          expectedUpdatedAt: input.expectedUpdatedAt,
          isAdmin:
            context.authz.user.isSuperAdmin ||
            context.authz.user.roles.some((role) => role.key === "admin"),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          access,
        });
        return {
          ok: true,
          ...result,
          id: input.documentId,
          status: "draft",
          href: `/expenses/reports?expense=${input.documentId}`,
        };
      } catch (error) {
        if (error instanceof DocumentEditError) {
          const code =
            error.status === 404
              ? "not_found"
              : error.status === 403
                ? "forbidden"
                : error.status === 409
                  ? "conflict"
                  : "invalid_input";
          throw new ApplicationError(code, error.message, error.status, {
            ...(error.remedy ? { remedy: error.remedy } : {}),
            ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
          });
        }
        throw error;
      }
    },
  }),
];
