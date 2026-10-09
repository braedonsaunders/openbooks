import { NextResponse } from "next/server";
import { z } from "zod";
import {
  releasePickWave,
  setPickDispatchPolicy,
} from "@openbooks/engine/src/sales/pick-execution.ts";
import { defineRoute } from "@/lib/api/route";
import { uuidId } from "@/lib/api/json";
import {
  executionKey,
  warehouseExecutionResponse,
} from "@/lib/api/warehouse-execution";
const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("release"),
    warehouseId: uuidId,
    subsidiaryId: uuidId,
    mode: z.enum(["cutoff", "priority"]),
    cutoffAt: z.iso.datetime({ offset: true }),
    pickListIds: z.array(uuidId).min(1).max(500).optional(),
    commandKey: executionKey,
  }),
  z.object({
    action: z.literal("policy"),
    pickListId: uuidId,
    priority: z.number().int().min(-2147483648).max(2147483647),
    cutoffAt: z.iso.datetime({ offset: true }),
  }),
]);
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  body,
  handler: async ({ authz, body }) =>
    warehouseExecutionResponse(async () =>
      NextResponse.json(
        body.action === "release"
          ? await releasePickWave(authz.user.orgId, authz.user.id, body)
          : await setPickDispatchPolicy(authz.user.orgId, authz.user.id, body),
      ),
    ),
});
