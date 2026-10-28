import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { guardSubsidiaryScope } from "@/lib/authz";
import { expenseAccess, authorizeExpenses } from "@/lib/expense-access";
import { isUuid } from "@/lib/list-params";
import { loadExpenseReport } from "@/lib/expenses";
import {
  deleteExpenseReport,
  expenseReportDeleteBodySchema,
  expenseReportUpdateBodySchema,
  updateExpenseReport,
} from "@/lib/expense-report-actions";

export const runtime = "nodejs";

const params = z.object({ id: z.string().refine(isUuid) });

export const GET = defineRoute({
  params,
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("read"),
  feature: "expenses",
  handler: async ({ authz, params: routeParams }) => {
    const access = await expenseAccess(authz, "read");
    if (!access) return notFound("record");
    const report = await loadExpenseReport(
      routeParams.id,
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
      access,
    );
    if (!report) return notFound("record");
    const denied = guardSubsidiaryScope(authz, report.doc.subsidiary_id as string | null);
    if (denied) return denied;
    return Response.json(report);
  },
});

/** Save a draft with the same revision fence and receipt confirmations as the native expense writer. */
export const PATCH = defineRoute({
  params,
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  body: expenseReportUpdateBodySchema,
  opaque: {
    extraDims: "segment dimensions are validated by name in prepareExpenseEdit",
    custom: "custom values are validated against the live definitions in prepareExpenseEdit",
  },
  handler: async ({ authz, params: routeParams, body }) =>
    updateExpenseReport(authz, routeParams.id, body),
});

/** Delete a draft only when revision, ownership, scope and posting safeguards allow it. */
export const DELETE = defineRoute({
  params,
  invalidParamsNotFound: "record",
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  body: expenseReportDeleteBodySchema,
  opaque: {
    expectedUpdatedAt: "an omitted token reaches the named revision refusal",
  },
  handler: async ({ authz, params: routeParams, body }) =>
    deleteExpenseReport(authz, routeParams.id, body),
});
