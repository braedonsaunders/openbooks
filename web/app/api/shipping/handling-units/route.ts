import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createHandlingUnit,
  getHandlingUnits,
  sealHandlingUnit,
  moveHandlingUnit,
  handlingUnitBinOptions,
} from "@openbooks/engine/src/sales/handling-units.ts";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import {
  executionKey,
  warehouseExecutionResponse,
} from "@/lib/api/warehouse-execution";
const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    shipmentId: uuidId,
    code: z.string().min(1).max(60),
    binId: uuidId,
    lineIds: z.array(uuidId).min(1).max(500),
  }),
  z.object({ action: z.literal("seal"), unitId: uuidId }),
  z.object({
    action: z.literal("move"),
    unitId: uuidId,
    toBinId: uuidId,
    date: isoDate(),
    reason: z.string().min(5).max(500),
    commandKey: executionKey,
  }),
]);
export const GET = defineRoute({
  permission: "orders.read",
  feature: "fulfillment",
  handler: async ({ authz, request }) =>
    warehouseExecutionResponse(async () => {
      const parsed = uuidId.safeParse(
        new URL(request.url).searchParams.get("shipmentId"),
      );
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid shipment" },
          { status: 422 },
        );
      const shipmentId = parsed.data;
      return NextResponse.json({
        units: await getHandlingUnits(
          authz.user.orgId,
          authz.user.id,
          shipmentId,
        ),
        bins: await handlingUnitBinOptions(
          authz.user.orgId,
          authz.user.id,
          shipmentId,
        ),
      });
    }),
});
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  body,
  handler: async ({ authz, body }) =>
    warehouseExecutionResponse(async () => {
      const org = authz.user.orgId,
        actor = authz.user.id;
      return NextResponse.json(
        body.action === "create"
          ? await createHandlingUnit(org, actor, body)
          : body.action === "seal"
            ? await sealHandlingUnit(org, actor, body.unitId)
            : await moveHandlingUnit(org, actor, body),
      );
    }),
});
