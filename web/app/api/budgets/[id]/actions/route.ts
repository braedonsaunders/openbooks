import { defineRoute } from "@/lib/api/route";
import {
  budgetScenarioActionSchema,
  executeBudgetScenarioAction,
} from "@/lib/budget-scenario-actions";

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "budgets.read",
  feature: "budgets",
  body: budgetScenarioActionSchema,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, params, body }) =>
    executeBudgetScenarioAction({
      request,
      authz,
      params,
      body: body as Record<string, unknown>,
    }),
});
