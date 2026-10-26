import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { correctWorkOrderOperationStart } from "@openbooks/engine/manufacturing/work-orders";
import { db } from "@openbooks/engine/platform/db";
import { isoDate } from "@/lib/api/json";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../../_transaction";
import { loadScopedWorkOrder } from "../../../../_scope";

const Params = z.object({ id: uuidString(), opId: uuidString() });
const Body = z.object({ startedOn: isoDate(), reason: z.string().trim().min(5).max(500) }).strict();

/** Correct an in-progress operation's start to the earlier day it actually began. */
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
        await correctWorkOrderOperationStart(
          db,
          authz.user.orgId,
          authz.user.id,
          params.id,
          params.opId,
          body,
        ),
      );
    }),
});
