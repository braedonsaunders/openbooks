import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listAvailableApplicationInventory } from "../../../../../lib/application/inventory-read";

export const runtime = "nodejs";

/**
 * GET /api/v1/inventory/available — promisable stock per item and warehouse:
 * on hand, committed and available from the availability engine, plus
 * incoming from approved purchase-order lines still on order.
 */
async function handleV1GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/inventory/available", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listAvailableApplicationInventory(context, {
        subsidiaryId: url.searchParams.get("subsidiaryId") ?? undefined,
        itemIds: url.searchParams.getAll("itemId"),
        itemCodes: url.searchParams.getAll("itemCode"),
        locationIds: url.searchParams.getAll("locationId"),
        changedSince: url.searchParams.get("changedSince") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request }) => handleV1GET(request),
});
