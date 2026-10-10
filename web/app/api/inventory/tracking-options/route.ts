import { z } from "zod";
import { NextResponse } from "next/server";
import { inventoryTrackingOptions } from "@openbooks/engine/inventory";
import { defineRoute } from "@/lib/api/route";
import { uuidId } from "@/lib/api/json";
import { apiErrorResponse } from "@/lib/api/error-response";
import { inventoryErrorStatus } from "@/lib/api/inventory-errors";
const query = z
  .object({
    itemId: uuidId,
    q: z.string().max(200).optional(),
    lotId: uuidId.optional(),
    selectedLotId:uuidId.optional(),
    selectedSerialId:uuidId.optional(),
  })
  .strict();
export const GET = defineRoute({
  permission: "items.read",
  feature: "inventory",
  handler: async ({ request, authz }) => {
    const parsed = query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      return NextResponse.json(
        { error: "Choose a valid inventory item" },
        { status: 422 },
      );
    try {
      return NextResponse.json(await inventoryTrackingOptions(authz.user.orgId, authz.user.id, parsed.data));
    } catch (error) {
      return apiErrorResponse(error, { safeStatus: inventoryErrorStatus(error) });
    }
  },
});
