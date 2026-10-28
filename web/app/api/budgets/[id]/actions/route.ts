import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import {
  budgetScenarioActionSchema,
  executeBudgetScenarioAction,
} from "@/lib/budget-scenario-actions";

export const runtime = "nodejs";

const params = z.object({ id: z.string() });

export const POST = defineRoute({
  permission: "budgets.read",
  feature: "budgets",
  params,
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
