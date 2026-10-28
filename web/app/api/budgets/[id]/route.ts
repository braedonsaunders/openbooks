import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { notFound } from "@/lib/api/responses";
import { loadBudgetScenario } from "../../../../lib/budgets";
import { BudgetMutationError } from "../../../../lib/budget-mutations";
import {
  budgetScenarioPatchSchema,
  deleteBudgetScenario,
  updateBudgetScenario,
} from "../../../../lib/budget-scenarios";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "budgets.read",
  feature: "budgets",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => {
    if (!isUuid(params.id)) return notFound("record");
    const scenario = await loadBudgetScenario(
      params.id,
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
    );
    if (!scenario) return notFound("record");
    return NextResponse.json(scenario);
  },
});

export const PATCH = defineRoute({
  permission: "budgets.manage",
  feature: "budgets",
  params: z.object({ id: z.string() }),
  body: budgetScenarioPatchSchema,
  handler: async ({ authz, params, body }) => {
    if (!isUuid(params.id)) return notFound("record");
    try {
      return NextResponse.json(await updateBudgetScenario(authz, params.id, body));
    } catch (error) {
      if (error instanceof BudgetMutationError) return apiErrorResponse(error);
      throw error;
    }
  },
});

export const DELETE = defineRoute({
  permission: "budgets.manage",
  feature: "budgets",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => {
    if (!isUuid(params.id)) return notFound("record");
    try {
      await deleteBudgetScenario(authz, params.id);
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof BudgetMutationError) return apiErrorResponse(error);
      throw error;
    }
  },
});
