import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { readWorkOrderReleaseReadiness } from "@openbooks/engine/manufacturing";
import { db } from "@openbooks/engine/platform/database";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: uuidString() });

export const GET = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  handler: async ({ authz, params }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const result = await loadScopedWorkOrder(authz, params.id);
      if (!result.ok) return result.response;
      return Response.json(
        await readWorkOrderReleaseReadiness(db, authz.user.orgId, authz.user.id, params.id),
      );
    }),
});
