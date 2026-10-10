import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { proposeRoutingActivation, getRouting } from "@openbooks/engine/src/manufacturing/routings.ts";
import { guardRoutingSubsidiaryScope } from "../../../_scope";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({subsidiaryId:z.string().uuid(),reason:z.string().trim().min(8).max(500)}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", scope:"unrestricted", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params, body, request }) => manufacturingTransaction(authz.user.orgId, async () => {
    const current = await getRouting(db, authz.user.orgId, params.id);
    if (!current) return notFound("routing");
    const denied = guardRoutingSubsidiaryScope(authz, current);
    if (denied) return denied;
    const key=z.string().uuid().safeParse(request.headers.get("Idempotency-Key"));
    if(!key.success)return Response.json({error:"Provide a UUID Idempotency-Key."},{status:400});
    return Response.json(await proposeRoutingActivation(db,authz.user.orgId,authz.user.id,params.id,{...body,idempotencyKey:key.data}));
  }),
});
