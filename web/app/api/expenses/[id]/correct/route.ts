import { defineRoute } from "@/lib/api/route";
import {
  correctExpenseReport,
  expenseReportCorrectionBodySchema,
} from "../../../../../lib/expense-report-actions";

export const runtime = "nodejs";

/** Correct a posted report through its native replacement and controlled-void workflow. */
export const POST = defineRoute({
  permission: "expenses.create",
  feature: "expenses",
  body: expenseReportCorrectionBodySchema,
  opaque: {
    extraDims: "segment dimensions are validated by name in prepareExpenseEdit",
    custom: "custom values are validated against the live definitions in prepareExpenseEdit",
  },
  handler: async ({ authz, params, body }) => correctExpenseReport(authz, params.id, body),
});
