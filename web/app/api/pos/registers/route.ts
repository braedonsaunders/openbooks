import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { listUsableRegisters } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";

export const runtime = "nodejs";

/** GET /api/pos/registers — active registers in the actor's legal entities, with their open session. */
export const GET = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  handler: async ({ authz }) => {
    try {
      return NextResponse.json({
        registers: await listUsableRegisters(
          db,
          authz.user.orgId,
          authz.allowedSubsidiaryIds ?? null,
        ),
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
