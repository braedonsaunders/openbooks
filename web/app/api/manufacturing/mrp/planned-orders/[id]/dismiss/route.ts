import { z } from "zod";
import { dismissPlannedOrder, getPlannedOrder } from "@openbooks/engine/src/manufacturing/mrp.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturingMrp", params: Params, body: Body,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const suggestion = await getPlannedOrder(db, authz.user.orgId, params.id);
    const denied = guardSubsidiaryScope(authz, suggestion.subsidiaryId);
    if (denied) return denied;
    return Response.json(await dismissPlannedOrder(db, authz.user.orgId, authz.user.id, params.id, body.reason));
  }),
});
