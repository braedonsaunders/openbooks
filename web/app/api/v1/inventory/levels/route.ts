import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationInventoryLevels } from "../../../../../lib/application/inventory-read";

export const runtime = "nodejs";

/** GET /api/v1/inventory/levels — on-hand quantity and value by item/location. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/inventory/levels", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationInventoryLevels(context, {
        itemId: url.searchParams.get("itemId") ?? undefined,
        stockLocationId: url.searchParams.get("stockLocationId") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
