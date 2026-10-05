import { z } from "zod";
import { listDemandPolicies, saveDemandPolicy } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../_transaction";

const Params = z.object({}).strict();
const Body = z.object({
  itemId: z.string().uuid(),
  subsidiaryId: z.string().uuid(),
  leadTimeDays: z.number().int().min(0).nullable(),
  reviewCycleDays: z.number().int().min(0).nullable(),
  serviceLevel: z.string().nullable(),
  moqQty: z.string().nullable(),
  casePackQty: z.string().nullable(),
  preferredSupplierId: z.string().uuid().nullable(),
  forecastMethod: z.enum(["auto", "seasonal", "intermittent", "average"]).nullable(),
  historyWeeks: z.number().int().min(4).max(156).nullable(),
}).strict();

export const GET = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params,
  handler: async ({ authz }) => planningTransaction(authz.user.orgId, async () => {
    const policies = await listDemandPolicies(db, authz.user.orgId);
    return Response.json([...policies.values()]);
  }),
});

export const POST = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params, body: Body,
  handler: async ({ authz, body }) => planningTransaction(authz.user.orgId, async () => {
    const denied = guardSubsidiaryScope(authz, body.subsidiaryId);
    if (denied) return denied;
    const { subsidiaryId: _subsidiaryId, ...policy } = body;
    return Response.json(await saveDemandPolicy(db, authz.user.orgId, authz.user.id, policy));
  }),
});
