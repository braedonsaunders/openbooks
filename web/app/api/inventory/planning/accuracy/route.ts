import { z } from "zod";
import { forecastAccuracy } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../_transaction";

const Params = z.object({}).strict();

export const GET = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params,
  handler: async ({ request, authz }) => planningTransaction(authz.user.orgId, async () => {
    const parsed = z.string().uuid().safeParse(new URL(request.url).searchParams.get("subsidiaryId"));
    if (!parsed.success) return Response.json({ error: "subsidiaryId must be a UUID" }, { status: 400 });
    const denied = guardSubsidiaryScope(authz, parsed.data);
    if (denied) return denied;
    return Response.json(await forecastAccuracy(db, authz.user.orgId, parsed.data));
  }),
});
