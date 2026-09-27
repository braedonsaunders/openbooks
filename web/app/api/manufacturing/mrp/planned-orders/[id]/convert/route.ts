import { z } from "zod";
import { convertPlannedOrder, getPlannedOrder } from "@openbooks/engine/src/manufacturing/mrp.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  fromLocationId: z.string().uuid().optional(), toLocationId: z.string().uuid().optional(),
}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturingMrp", params: Params, body: Body,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const suggestion = await getPlannedOrder(db, authz.user.orgId, params.id);
    const denied = guardSubsidiaryScope(authz, suggestion.subsidiaryId);
    if (denied) return denied;
    if (suggestion.action === "buy") {
      if (!authz.permissions.has("ap.create")) {
        return Response.json({ error: "forbidden", permission: "ap.create", message: "Missing required grant: ap.create." }, { status: 403 });
      }
    }
    const result = await convertPlannedOrder(db, authz.user.orgId, authz.user.id, params.id, body);
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  }),
});
