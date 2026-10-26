import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { getDemandRun } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../../_transaction";

const Params = z.object({ id: uuidString() });

export const GET = defineRoute({
  permission: "inventory.plan",
  feature: "demandPlanning",
  params: Params,
  handler: async ({ request, authz, params }) =>
    planningTransaction(authz.user.orgId, async () => {
      const parsed = uuidString().safeParse(new URL(request.url).searchParams.get("subsidiaryId"));
      if (!parsed.success)
        return Response.json({ error: "subsidiaryId must be a UUID" }, { status: 400 });
      const denied = guardSubsidiaryScope(authz, parsed.data);
      if (denied) return denied;
      return Response.json(await getDemandRun(db, authz.user.orgId, parsed.data, params.id));
    }),
});
