import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { readSessionSummary } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";
import { posJson } from "@/lib/pos";

export const runtime = "nodejs";

/**
 * GET /api/pos/sessions/[id] — the session report: an X report while the
 * session is open, the Z report once it is closed.
 */
export const GET = defineRoute({
  permission: "pos.drawer",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json({
        summary: posJson(
          await readSessionSummary(
            db,
            authz.user.orgId,
            params.id,
            authz.allowedSubsidiaryIds ?? null,
          ),
        ),
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
