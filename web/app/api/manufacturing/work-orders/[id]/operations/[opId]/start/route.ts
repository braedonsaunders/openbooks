import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { startWorkOrderOperation } from "@openbooks/engine/manufacturing/work-orders";
import { db } from "@openbooks/engine/platform/db";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../../_transaction";
import { loadScopedWorkOrder } from "../../../../_scope";

const Params = z.object({ id: uuidString(), opId: uuidString() });
const Body = z.object({ startedOn: z.string().nullable() }).strict();

export const POST = defineRoute({
  permission: "items.post",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      if (!can(authz, "manufacturing.manage")) {
        return Response.json(
          { error: "missing permission: manufacturing.manage" },
          { status: 403 },
        );
      }
      const result = await loadScopedWorkOrder(authz, params.id);
      if (!result.ok) return result.response;
      return Response.json(
        await startWorkOrderOperation(db, authz.user.orgId, authz.user.id, params.id, params.opId, {
          startedOn: body.startedOn ?? null,
        }),
      );
    }),
});
