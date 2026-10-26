import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { defineRoute } from "@/lib/api/route";
import { searchPosItems } from "@openbooks/engine/pos";

export const runtime = "nodejs";

/**
 * GET /api/pos/items?q= — the register's item lookup. A scanned or typed
 * code that matches an item exactly comes first, so a barcode scanner that
 * types the item code and Enter adds that item; otherwise code and name
 * matches follow.
 */
export const GET = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  handler: async ({ authz, request }) => {
    const items = await searchPosItems(
      db,
      authz.user.orgId,
      new URL(request.url).searchParams.get("q") ?? "",
    );
    return NextResponse.json({ items });
  },
});
