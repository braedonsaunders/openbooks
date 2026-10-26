import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { createOperationInspection } from "@openbooks/engine/manufacturing/quality-execution";
export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  body: z
    .object({
      workOrderId: uuidString(),
      operationId: uuidString(),
      id: uuidString(),
      quantity: z.string(),
    })
    .strict(),
  handler: async ({ authz, body }) =>
    withOrgTransaction(authz.user.orgId, async () =>
      Response.json(
        await createOperationInspection(
          db,
          authz.user.orgId,
          authz.user.id,
          body.workOrderId,
          body.operationId,
          { id: body.id, quantity: body.quantity },
        ),
      ),
    ),
});
