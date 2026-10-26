import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { defineRoute } from "@/lib/api/route";
import { searchPosCustomers } from "@openbooks/engine/pos";

export const runtime = "nodejs";

/** GET /api/pos/customers?q= — find a customer for the sale among the native customer parties. */
export const GET = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  handler: async ({ authz, request }) => {
    const customers = await searchPosCustomers(
      db,
      authz.user.orgId,
      new URL(request.url).searchParams.get("q") ?? "",
      authz.allowedSubsidiaryIds ?? null,
    );
    return NextResponse.json({ customers });
  },
});
