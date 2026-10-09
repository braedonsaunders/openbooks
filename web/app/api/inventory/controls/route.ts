import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { uuidId, isoDate, exactMoney, nullableUuidId } from "@/lib/api/json";
import { apiErrorResponse } from "@/lib/api/error-response";
import { inventoryErrorStatus } from "@/lib/api/inventory-errors";
import { guardPermission } from "@/lib/authz";
import { inventoryInquiry } from "@openbooks/engine/inventory";
import { setStockHold } from "@openbooks/engine/inventory";
import { moveConsignment } from "@openbooks/engine/inventory";
import { executeIdempotentInventoryAction } from "@openbooks/engine/inventory";

const inquiry = z
  .object({
    view: z.enum([
      "holds",
      "consignment",
      "cycle_due",
      "layers",
      "consumptions",
    ]),
    itemId: uuidId.optional(),
    stockLocationId: uuidId.optional(),
    layerId: uuidId.optional(),
    stockId: uuidId.optional(),
    page: z.coerce.number().int().min(0).max(100000).optional(),
    search: z.string().max(200).optional(),
    includeClosed: z.enum(["true", "false"]).optional(),
  })
  .strict();
export const GET = defineRoute({
  permission: "items.read",
  feature: "inventory",
  handler: async ({ request, authz }) => {
    const parsed = inquiry.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      return NextResponse.json(
        { error: "Invalid inventory inquiry filters" },
        { status: 422 },
      );
    try {
      return NextResponse.json(
        await inventoryInquiry(authz.user.orgId, authz.user.id, {
          ...parsed.data,
          includeClosed: parsed.data.includeClosed === "true",
        }),
      );
    } catch (error) {
      return apiErrorResponse(error, {
        safeStatus: inventoryErrorStatus(error),
      });
    }
  },
});
const body = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("hold"),
    idempotencyKey: z.string(),
    kind: z.enum(["lot", "serial"]),
    id: uuidId,
    held: z.boolean(),
    reason: z.string().min(5).max(500),
  }),
  z.object({
    operation: z.literal("consignment"),
    idempotencyKey: z.string(),
    action: z.enum(["receive", "transfer", "return", "take_ownership"]),
    stockId: uuidId.optional(),
    itemId: uuidId.optional(),
    stockLocationId: uuidId.optional(),
    subsidiaryId: uuidId.optional(),
    toStockLocationId: uuidId.optional(),
    quantity: exactMoney(),
    date: isoDate(),
    reason: z.string().min(5).max(500),
    lotId: nullableUuidId.optional(),
    serialId: nullableUuidId.optional(),
    unitCost: exactMoney().optional(),
    offsetAccountId: uuidId.optional(),
  }),
]);
export const POST = defineRoute({
  authorize: async ({ request }) => {
    let value: unknown;
    try {
      value = await request.clone().json();
    } catch {
      return NextResponse.json(
        { error: "Inventory command must be valid JSON" },
        { status: 422 },
      );
    }
    const hold =
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      value.operation === "hold";
    return guardPermission(hold ? "items.manage" : "items.post");
  },
  feature: "inventory",
  body,
  handler: async ({ body: input, authz }) => {
    try {
      const { idempotencyKey, operation, ...command } = input;
      const result = await executeIdempotentInventoryAction<
        Record<string, unknown>
      >(authz.user.orgId, authz.user.id, {
        operation: `inventory.${operation}`,
        idempotencyKey,
        request: command,
        execute: () =>
          input.operation === "hold"
            ? setStockHold(authz.user.orgId, authz.user.id, input)
            : moveConsignment(authz.user.orgId, authz.user.id, input),
      });
      return NextResponse.json({
        ok: true,
        ...result.value,
        replayed: result.replayed,
      });
    } catch (error) {
      return apiErrorResponse(error, {
        safeStatus: inventoryErrorStatus(error),
      });
    }
  },
});
