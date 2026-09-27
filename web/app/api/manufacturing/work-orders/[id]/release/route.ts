import { z } from "zod";
import { getWorkOrder, releaseWorkOrder } from "@openbooks/engine/src/manufacturing/work-orders.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { ManufacturingError } from "@openbooks/engine/src/manufacturing/errors.ts";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { dispatchWorkOrderFlow } from "../../_flows";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const result = await loadScopedWorkOrder(authz, params.id, true);
    if (!result.ok) return result.response;
    if (result.order.pendingApproval) return Response.json(result.order, { status: 202 });
    if (result.order.status !== "draft") {
      return Response.json(await releaseWorkOrder(db, authz.user.orgId, authz.user.id, params.id, { reason: body.reason }), { status: 200 });
    }
    const flow = await dispatchWorkOrderFlow({ kind: "on_submit" }, params.id, authz.user.orgId, authz.user.id);
    if (flow.gatesCreated > 0) {
      const pending = await getWorkOrder(db, authz.user.orgId, params.id);
      if (!pending?.pendingApproval) {
        throw new ManufacturingError("The work-order approval gate was created but is not visible on the order.", {
          status: 409, code: "work_order_approval_not_recorded", remedy: "Reload the work order and contact an administrator if approval is not pending.",
        });
      }
      return Response.json(pending, { status: 202 });
    }
    const order = await releaseWorkOrder(db, authz.user.orgId, authz.user.id, params.id, {
      reason: body.reason,
    });
    return Response.json(order);
  }),
});
