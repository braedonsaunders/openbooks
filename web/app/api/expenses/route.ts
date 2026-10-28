import { defineRoute } from "@/lib/api/route";
import { authorizeExpenses } from "../../../lib/expense-access";
import {
  createExpenseReport,
  expenseReportCreateBodySchema,
} from "../../../lib/expense-report-actions";

export const runtime = "nodejs";

/** Create a numbered expense draft and its validated lines in one transaction. */
export const POST = defineRoute({
  authorize: authorizeExpenses("edit"),
  feature: "expenses",
  body: expenseReportCreateBodySchema,
  opaque: {
    extraDims: "segment dimensions are validated by name in prepareExpenseEdit",
    custom: "custom values are validated against the live definitions in prepareExpenseEdit",
  },
  handler: async ({ authz, body, request }) =>
    createExpenseReport(authz, body, request.headers.get("Idempotency-Key") ?? ""),
});
