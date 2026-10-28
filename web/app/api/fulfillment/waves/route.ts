import { NextResponse } from "next/server";
import { releasePickWave, setPickDispatchPolicy } from "@openbooks/engine/sales/pick-execution";
import { defineRoute } from "@/lib/api/route";
import { warehouseExecutionResponse } from "@/lib/api/warehouse-execution";
import { pickWaveBody } from "@/lib/api/pick-wave";
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  body: pickWaveBody,
  handler: async ({ authz, body }) =>
    warehouseExecutionResponse(async () =>
      NextResponse.json(
        body.action === "release"
          ? await releasePickWave(authz.user.orgId, authz.user.id, body)
          : await setPickDispatchPolicy(authz.user.orgId, authz.user.id, body),
      ),
    ),
});
