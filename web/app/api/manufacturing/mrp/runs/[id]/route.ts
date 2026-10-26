import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { getMrpRun } from "@openbooks/engine/manufacturing/mrp";
import { db } from "@openbooks/engine/platform/db";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: uuidString() });

export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturingMrp",
  params: Params,
  handler: async ({ authz, params }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const result = await getMrpRun(db, authz.user.orgId, params.id);
      const denied = guardSubsidiaryScope(authz, String(result.run.parameters.subsidiaryId ?? ""));
      if (denied) return denied;
      return Response.json(result);
    }),
});
