import { z } from "zod";
import { holdWorkOrder } from "@openbooks/engine/src/manufacturing/work-orders.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { dispatchWorkOrderFlow } from "../../_flows";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const result = await loadScopedWorkOrder(authz, params.id, true);
    if (!result.ok) return result.response;
    if (result.order.status === "on_hold") return Response.json(result.order);
    const order = await holdWorkOrder(db, authz.user.orgId, authz.user.id, params.id, body.reason);
    await dispatchWorkOrderFlow({ kind: "status_change", from: result.order.status, to: "on_hold" }, params.id, authz.user.orgId, authz.user.id);
    return Response.json(order);
  }),
});
