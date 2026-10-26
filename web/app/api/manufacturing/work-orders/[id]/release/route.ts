import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { releaseWorkOrder } from "@openbooks/engine/manufacturing/work-orders";
import { db } from "@openbooks/engine/platform/db";

import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: uuidString() });
const Body = z
  .object({ reason: z.string().trim().max(500).nullable().optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const result = await loadScopedWorkOrder(authz, params.id, true);
      if (!result.ok) return result.response;
      if (result.order.pendingApproval) return Response.json(result.order, { status: 202 });
      if (result.order.status !== "draft") {
        return Response.json(
          await releaseWorkOrder(db, authz.user.orgId, authz.user.id, params.id, {
            reason: body.reason,
          }),
          { status: 200 },
        );
      }
      const order = await releaseWorkOrder(db, authz.user.orgId, authz.user.id, params.id, {
        reason: body.reason,
      });
      return Response.json(order, { status: order.pendingApproval ? 202 : 200 });
    }),
});
