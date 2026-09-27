import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { archiveRouting, getRouting } from "@openbooks/engine/src/manufacturing/routings.ts";
import { guardRoutingSubsidiaryScope } from "../../../_scope";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params }) => manufacturingTransaction(authz.user.orgId, async () => {
    const current = await getRouting(db, authz.user.orgId, params.id);
    if (!current) return notFound("routing");
    const denied = guardRoutingSubsidiaryScope(authz, current);
    if (denied) return denied;
    return Response.json(await archiveRouting(db, authz.user.orgId, authz.user.id, params.id));
  }),
});
