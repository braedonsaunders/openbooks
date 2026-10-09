import { NextResponse } from "next/server";
import { z } from "zod";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import {
  confirmExecutionTask,
  executionTaskView,
} from "@openbooks/engine/src/inventory/directed-execution.ts";
import {
  suggestReceiptConfirmation,
  suggestPutaway,
  suggestCountObservation,
  executeInventoryDirection,
} from "@openbooks/engine/src/inventory/warehouse-directions.ts";
import { defineRoute } from "@/lib/api/route";
import { exactMoney, isoDate, uuidId } from "@/lib/api/json";
import {
  confirmExecutionBody,
  executionKey,
  warehouseExecutionResponse,
} from "@/lib/api/warehouse-execution";
const body = z.discriminatedUnion("action", [
  confirmExecutionBody,
  z.object({
    action: z.literal("receive"),
    lineId: uuidId,
    commandKey: executionKey,
  }),
  z.object({
    action: z.literal("putaway"),
    warehouseId: uuidId,
    stagingLocationId: uuidId,
    itemId: uuidId,
    subsidiaryId: uuidId,
    quantity: exactMoney(),
    date: isoDate(),
    lotId: uuidId.nullable().optional(),
    serialId: uuidId.nullable().optional(),
    commandKey: executionKey,
  }),
  z.object({
    action: z.literal("count"),
    lineId: uuidId,
    quantity: exactMoney(),
    observation: z.enum(["first", "second"]),
    reason: z.string().max(500).optional(),
    commandKey: executionKey,
  }),
]);
export const POST = defineRoute({
  permission: "items.post",
  feature: "inventory",
  body,
  handler: async ({ authz, body }) =>
    warehouseExecutionResponse(async () => {
      const org = authz.user.orgId,
        actor = authz.user.id;
      if (body.action === "confirm")
        return NextResponse.json(
          await confirmExecutionTask(org, actor, body, (tx, task) =>
            executeInventoryDirection(tx, org, actor, task),
          ),
        );
      const task =
        body.action === "receive"
          ? await suggestReceiptConfirmation(org, actor, body)
          : body.action === "putaway"
            ? await suggestPutaway(org, actor, body)
            : await suggestCountObservation(org, actor, body);
      return NextResponse.json({
        task: await withOrgTransaction(org, () =>
          executionTaskView(db, org, actor, task.id),
        ),
      });
    }),
});
