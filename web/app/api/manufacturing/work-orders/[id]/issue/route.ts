import { z } from "zod";
import { issueMaterials } from "@openbooks/engine/src/manufacturing/materials.ts";
import { executeManufacturingIssue } from "@openbooks/engine/src/manufacturing/execution.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  lines: z.array(z.object({
    materialId: z.string().uuid(), quantity: z.string(), lotId: z.string().uuid().nullable().optional(),
    serialId: z.string().uuid().nullable().optional(),
  }).strict()).min(1).max(500),
}).strict();

export const POST = defineRoute({
  permission: "items.post", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ request, authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    if (!can(authz, "manufacturing.manage")) {
      return Response.json({ error: "missing permission: manufacturing.manage" }, { status: 403 });
    }
    const result = await loadScopedWorkOrder(authz, params.id);
    if (!result.ok) return result.response;
    const key=request.headers.get('Idempotency-Key');
    if(key){const result=await executeManufacturingIssue(authz.user.orgId,authz.user.id,authz.allowedSubsidiaryIds,params.id,key,body.lines);return Response.json(result.value,{headers:{'Idempotency-Replayed':String(result.replayed)}});}
    return Response.json(await issueMaterials(db, authz.user.orgId, authz.user.id, params.id, body.lines));
  }),
});
