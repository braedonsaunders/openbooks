import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import {
  checkWorkOrderCreateReplay,
  createWorkOrder,
  type WorkOrderInput,
} from "@openbooks/engine/manufacturing/work-orders";
import { db } from "@openbooks/engine/platform/db";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../_idempotent";
import { manufacturingTransaction } from "../_transaction";

const Params = z.object({}).strict();
const Body = z
  .object({
    producedItemId: uuidString(),
    quantityOrdered: z.string(),
    subsidiaryId: uuidString(),
    productionMode: z.enum(["order", "batch", "continuous"]).optional(),
    campaignReference: z.string().trim().max(100).nullable().optional(),
    issueLocationId: uuidString().nullable().optional(),
    receiptLocationId: uuidString().nullable().optional(),
    plannedStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    plannedEnd: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    routingId: uuidString().nullable().optional(),
    priority: z.enum(["low", "normal", "high", "rush"]).optional(),
    source: z.enum(["manual", "sales_order"]).optional(),
    sourceRefId: uuidString().nullable().optional(),
    operatingProfile: z.string().nullable().optional(),
    operatingDepartmentId: uuidString().nullable().optional(),
  })
  .strict();

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const input = body as WorkOrderInput;
      const denied = guardSubsidiaryScope(authz, input.subsidiaryId);
      if (denied) return denied;
      const match = { ...input };
      const row = await idempotentManufacturingCreate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        request,
        table: "mfg_work_orders",
        match,
        create: (id, requestId) =>
          createWorkOrder(db, authz.user.orgId, authz.user.id, input, { id, requestId }),
        load: () =>
          checkWorkOrderCreateReplay(
            db,
            authz.user.orgId,
            authz.user.id,
            request.headers.get("Idempotency-Key")!.trim(),
            authz.allowedSubsidiaryIds,
          ),
      });
      return created(row);
    }),
});
