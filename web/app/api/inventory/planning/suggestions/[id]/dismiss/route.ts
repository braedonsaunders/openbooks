import { z } from "zod";
import { dismissPlanSuggestion, getPlanSuggestion } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ reason: z.string().min(5).max(500) }).strict();

export const POST = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params, body: Body,
  handler: async ({ authz, params, body }) => planningTransaction(authz.user.orgId, async () => {
    const suggestion = await getPlanSuggestion(db, authz.user.orgId, params.id);
    const denied = guardSubsidiaryScope(authz, suggestion.subsidiaryId);
    if (denied) return denied;
    return Response.json(await dismissPlanSuggestion(db, authz.user.orgId, authz.user.id, params.id, body.reason));
  }),
});
