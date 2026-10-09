import { NextResponse } from "next/server";
import { z } from "zod";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import {
  confirmExecutionTask,
  executionTaskView,
} from "@openbooks/engine/src/inventory/directed-execution.ts";
import {
  suggestPickConfirmation,
  executePickDirection,
} from "@openbooks/engine/src/sales/pick-execution.ts";
import {
  suggestPackConfirmation,
  executePackDirection,
} from "@openbooks/engine/src/sales/handling-units.ts";
import { defineRoute } from "@/lib/api/route";
import { uuidId } from "@/lib/api/json";
import {
  confirmExecutionBody,
  executionKey,
  executionQuantity,
  warehouseExecutionResponse,
} from "@/lib/api/warehouse-execution";
const body = z.discriminatedUnion("action", [
  confirmExecutionBody,
  z.object({
    action: z.literal("pick"),
    lineId: uuidId,
    quantity: executionQuantity,
    reason: z.string().max(500).optional(),
    commandKey: executionKey,
  }),
  z.object({
    action: z.literal("pack"),
    unitId: uuidId,
    lineId: uuidId,
    commandKey: executionKey,
  }),
]);
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  body,
  handler: async ({ authz, body }) =>
    warehouseExecutionResponse(async () => {
      const org = authz.user.orgId,
        actor = authz.user.id;
      if (body.action === "confirm")
        return NextResponse.json(
          await confirmExecutionTask(org, actor, body, (tx, task) =>
            task.stage === "pick"
              ? executePickDirection(tx, org, actor, task)
              : executePackDirection(tx, org, actor, task),
          ),
        );
      const task =
        body.action === "pick"
          ? await suggestPickConfirmation(org, actor, body)
          : await suggestPackConfirmation(org, actor, body);
      return NextResponse.json({
        task: await withOrgTransaction(org, () =>
          executionTaskView(db, org, actor, task.id),
        ),
      });
    }),
});
