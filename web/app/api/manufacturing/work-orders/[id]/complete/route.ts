import { z } from "zod";
import { isoDate } from "@/lib/api/json";
import { completeWorkOrder } from "@openbooks/engine/src/manufacturing/completion.ts";
import { executeManufacturingReceipt } from "@openbooks/engine/src/manufacturing/execution.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { can } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../_transaction";
import { loadScopedWorkOrder } from "../../_scope";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  quantity: z.string(),
  receiptLocationId: z.string().uuid().nullable().optional(),
  lots: z.array(z.object({
    itemId: z.string().uuid().optional(), quantity: z.string(),
    lotNumber: z.string().trim().min(1).optional(), expiresOn: isoDate().nullable().optional(),
    serialNumber: z.string().trim().min(1).optional(),
  }).strict()).max(200).optional(),
  byproductValues: z.array(z.object({
    itemId: z.string().uuid(), nrvUnit: z.string(), reason: z.string().trim().min(5).max(500),
  }).strict()).max(100).optional(),
}).strict();

export const POST = defineRoute({
  permission: "items.post", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ request, authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    if (!can(authz, "manufacturing.manage")) {
      return Response.json({ error: "missing permission: manufacturing.manage" }, { status: 403 });
    }
    const scoped = await loadScopedWorkOrder(authz, params.id);
    if (!scoped.ok) return scoped.response;
    const key=request.headers.get('Idempotency-Key');
    if(key){const result=await executeManufacturingReceipt(authz.user.orgId,authz.user.id,authz.allowedSubsidiaryIds,params.id,key,body);return Response.json(result.value,{headers:{'Idempotency-Replayed':String(result.replayed)}});}
    return Response.json(await completeWorkOrder(db, authz.user.orgId, authz.user.id, params.id, body));
  }),
});
