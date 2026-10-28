import { NextResponse } from "next/server";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import {
  confirmExecutionTask,
  executionTaskView,
} from "@openbooks/engine/inventory/directed-execution";
import {
  suggestPickConfirmation,
  executePickDirection,
} from "@openbooks/engine/sales/pick-execution";
import {
  suggestPackConfirmation,
  executePackDirection,
} from "@openbooks/engine/sales/handling-units";
import { defineRoute } from "@/lib/api/route";
import { executionActionBody, warehouseExecutionResponse } from "@/lib/api/warehouse-execution";
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  body: executionActionBody,
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
        task: await withOrgTransaction(org, () => executionTaskView(db, org, actor, task.id)),
      });
    }),
});
