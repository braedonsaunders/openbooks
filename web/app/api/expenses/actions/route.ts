import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { DocumentEditError } from "@openbooks/engine/records/document-edit-policy";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";
import { recallExpenseReport } from "@/lib/expense-actions";
import {
  expenseSubmissionAccess,
  findExpenseReportInScope,
  postExpenseReport,
  submitExpenseReport,
} from "../../../../lib/expense-report-actions";

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

/** Expense lifecycle: draft → submit → approved → post; approvals are decided through Flows. */
export const POST = defineRoute({
  public: "session",
  body: POSTBodySchema1,
  handler: async ({ body: routeBody }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isFeatureEnabled(authz.user.orgId, "expenses"))) return notFound("record");

    try {
      switch (routeBody.action) {
        case "submit":
          return submitExpenseReport(authz, routeBody.documentId);
        case "post":
          return postExpenseReport(authz, routeBody.documentId);
        case "recall": {
          const access = await expenseSubmissionAccess(authz);
          if (!access) {
            return NextResponse.json(
              { error: "missing permission: expenses.create" },
              { status: 403 },
            );
          }
          const expense = await findExpenseReportInScope(routeBody.documentId, authz, access);
          if (!expense) return notFound("record");
          try {
            const outcome = await recallExpenseReport({
              documentId: routeBody.documentId,
              orgId: authz.user.orgId,
              actorId: authz.user.id,
              expectedUpdatedAt: routeBody.expectedUpdatedAt,
              isAdmin:
                authz.user.isSuperAdmin || authz.user.roles.some((role) => role.key === "admin"),
              allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
              access,
            });
            return NextResponse.json({ ok: true, ...outcome });
          } catch (error) {
            if (error instanceof DocumentEditError) {
              return error.status === 404 ? notFound("record") : apiErrorResponse(error);
            }
            throw error;
          }
        }
      }
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
