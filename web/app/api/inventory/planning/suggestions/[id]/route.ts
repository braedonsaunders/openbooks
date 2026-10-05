import { z } from "zod";
import { getPlanSuggestion, listPlanSuggestions } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../../_transaction";

const Params = z.object({ id: z.string().uuid() });

/**
 * One suggestion with its run's entity, so the drawer resolves the right
 * subsidiary from the suggestion itself instead of trusting a parameter.
 */
export const GET = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params,
  handler: async ({ authz, params }) => planningTransaction(authz.user.orgId, async () => {
    const locked = await getPlanSuggestion(db, authz.user.orgId, params.id);
    const denied = guardSubsidiaryScope(authz, locked.subsidiaryId);
    if (denied) return denied;
    const resolved = (await listPlanSuggestions(db, authz.user.orgId, locked.subsidiaryId, "all"))
      .find((row) => row.id === params.id) ?? null;
    return Response.json({ suggestion: resolved, subsidiaryId: locked.subsidiaryId });
  }),
});
