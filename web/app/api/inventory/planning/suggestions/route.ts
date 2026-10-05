import { z } from "zod";
import { listPlanSuggestions } from "@openbooks/engine/inventory";
import { db } from "@openbooks/engine/platform/database";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { planningTransaction } from "../_transaction";

const Params = z.object({}).strict();
const Status = z.enum(["suggested", "confirmed", "converted", "dismissed", "open", "all"]);

export const GET = defineRoute({
  permission: "inventory.plan", feature: "demandPlanning", params: Params,
  handler: async ({ request, authz }) => planningTransaction(authz.user.orgId, async () => {
    const url = new URL(request.url);
    const subsidiary = z.string().uuid().safeParse(url.searchParams.get("subsidiaryId"));
    if (!subsidiary.success) return Response.json({ error: "subsidiaryId must be a UUID" }, { status: 400 });
    const denied = guardSubsidiaryScope(authz, subsidiary.data);
    if (denied) return denied;
    const status = Status.safeParse(url.searchParams.get("status") ?? "open");
    if (!status.success) return Response.json({ error: "status must be suggested, confirmed, converted, dismissed, open or all" }, { status: 400 });
    return Response.json(await listPlanSuggestions(db, authz.user.orgId, subsidiary.data, status.data));
  }),
});
