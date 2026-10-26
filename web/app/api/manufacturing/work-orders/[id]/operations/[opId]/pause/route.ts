import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { pauseWorkOrderOperation } from "@openbooks/engine/manufacturing/work-orders";
import { db } from "@openbooks/engine/platform/db";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../../_transaction";
import { loadScopedWorkOrder } from "../../../../_scope";

const Params = z.object({ id: uuidString(), opId: uuidString() });
const Body = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const result = await loadScopedWorkOrder(authz, params.id);
      if (!result.ok) return result.response;
      return Response.json(
        await pauseWorkOrderOperation(
          db,
          authz.user.orgId,
          authz.user.id,
          params.id,
          params.opId,
          body.reason,
        ),
      );
    }),
});
