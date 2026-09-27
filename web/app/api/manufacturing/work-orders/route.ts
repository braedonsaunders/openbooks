import { z } from "zod";
import { createWorkOrder, getWorkOrder, type WorkOrderInput } from "@openbooks/engine/src/manufacturing/work-orders.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../_idempotent";
import { manufacturingTransaction } from "../_transaction";

const Params = z.object({}).strict();
const Body = z.object({
  producedItemId: z.string().uuid(), quantityOrdered: z.string(), subsidiaryId: z.string().uuid(),
  issueLocationId: z.string().uuid().nullable().optional(), receiptLocationId: z.string().uuid().nullable().optional(),
  plannedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  plannedEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  routingId: z.string().uuid().nullable().optional(), priority: z.enum(["low", "normal", "high", "rush"]).optional(),
  source: z.enum(["manual", "sales_order"]).optional(), sourceRefId: z.string().uuid().nullable().optional(),
}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ request, authz, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const input = body as WorkOrderInput;
    const denied = guardSubsidiaryScope(authz, input.subsidiaryId);
    if (denied) return denied;
    const match = { ...input };
    const row = await idempotentManufacturingCreate({
      orgId: authz.user.orgId, request, table: "mfg_work_orders", match,
      create: (id, requestId) => createWorkOrder(db, authz.user.orgId, authz.user.id, input, { id, requestId }),
      load: () => getWorkOrder(db, authz.user.orgId, request.headers.get("Idempotency-Key")!.trim()),
    });
    return created(row);
  }),
});
