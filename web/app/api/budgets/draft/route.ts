import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { BudgetMutationError } from "../../../../lib/budget-mutations";
import {
  budgetScenarioCreateSchema,
  BudgetScenarioSourceNotFoundRefusal,
  createBudgetScenario,
} from "../../../../lib/budget-scenarios";

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "budgets.manage",
  feature: "budgets",
  body: budgetScenarioCreateSchema,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json(await createBudgetScenario(authz, body));
    } catch (error) {
      if (
        error instanceof BudgetMutationError ||
        error instanceof BudgetScenarioSourceNotFoundRefusal
      ) {
        return apiErrorResponse(error);
      }
      throw error;
    }
  },
});
