import { z } from "zod";
import { cancelWorkOrder } from "@openbooks/engine/src/manufacturing/work-orders.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const result = await loadScopedWorkOrder(authz, params.id);
    if (!result.ok) return result.response;
    return Response.json(await cancelWorkOrder(db, authz.user.orgId, authz.user.id, params.id, body.reason));
  }),
});
