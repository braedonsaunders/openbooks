import { z } from "zod";
import { NextResponse } from "next/server";
import { closeSession } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";
import { posCountSchema } from "@/lib/api/pos-schemas";
import { posJson } from "@/lib/pos";

export const runtime = "nodejs";

/**
 * POST /api/pos/sessions/[id]/close — close the session with the blind
 * drawer count. The expected cash and over/short are computed server-side
 * and returned only after the count is committed.
 */
export const POST = defineRoute({
  permission: "pos.drawer",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  body: z
    .object({
      closingCount: posCountSchema,
      note: z.string().trim().max(1000).nullable().optional(),
    })
    .strict(),
  handler: async ({ authz, params, body }) => {
    try {
      const summary = await closeSession({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        sessionId: params.id,
        closingCount: body.closingCount,
        note: body.note ?? null,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
      });
      return NextResponse.json({ summary: posJson(summary) });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
