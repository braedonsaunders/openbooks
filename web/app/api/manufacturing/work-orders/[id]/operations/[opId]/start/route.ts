import { z } from "zod";
import { startWorkOrderOperation } from "@openbooks/engine/src/manufacturing/work-orders.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../../_transaction";
import { loadScopedWorkOrder } from "../../../../_scope";

const Params = z.object({ id: z.string().uuid(), opId: z.string().uuid() });
const Body = z.object({}).strict();

export const POST = defineRoute({
  permission: "items.post", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params }) => manufacturingTransaction(authz.user.orgId, async () => {
    if (!can(authz, "manufacturing.manage")) {
      return Response.json({ error: "missing permission: manufacturing.manage" }, { status: 403 });
    }
    const result = await loadScopedWorkOrder(authz, params.id);
    if (!result.ok) return result.response;
    return Response.json(await startWorkOrderOperation(db, authz.user.orgId, authz.user.id, params.id, params.opId));
  }),
});
