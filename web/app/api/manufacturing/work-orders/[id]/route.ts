import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import {
  updateDraftWorkOrder,
  type WorkOrderPatch,
} from "@openbooks/engine/manufacturing/work-orders";
import { db } from "@openbooks/engine/platform/db";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../_transaction";
import { loadScopedWorkOrder } from "../_scope";

const Params = z.object({ id: uuidString() });
const Patch = z
  .object({
    quantityOrdered: z.string().optional(),
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
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const GET = defineRoute({
  permission: "manufacturing.read",
  feature: "manufacturing",
  params: Params,
  handler: async ({ authz, params }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const result = await loadScopedWorkOrder(authz, params.id);
      if (!result.ok) return result.response;
      return Response.json(result.order);
    }),
});

export const PATCH = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Patch,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const result = await loadScopedWorkOrder(authz, params.id);
      if (!result.ok) return result.response;
      return Response.json(
        await updateDraftWorkOrder(
          db,
          authz.user.orgId,
          authz.user.id,
          params.id,
          body as WorkOrderPatch,
        ),
      );
    }),
});
