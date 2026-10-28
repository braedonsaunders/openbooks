import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { expenseAccessForScope, expenseGrantScope } from "@openbooks/engine/records/expense-access";
import { DocumentEditError } from "@openbooks/engine/records/document-edit-policy";
import { isFeatureEnabled } from "../features";
import { can } from "../authz";
import { recallExpenseReport } from "../expense-actions";
import { ApplicationError, forbidden, notFound } from "./errors";
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

export const PURCHASING_EXPENSE_TOOLS: ApplicationToolDefinition[] = [
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
      const scope = expenseGrantScope((permission) => can(context.authz, permission), "edit");
      if (scope === null) throw forbidden("expenses.create");
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
