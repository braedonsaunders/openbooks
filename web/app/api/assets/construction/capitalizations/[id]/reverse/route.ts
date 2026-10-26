import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { reverseCipCapitalization } from "@openbooks/engine/assets/asset-cip";
import { calendarDate, id, reasonText, scopeOf } from "../../../../_depth";

export const runtime = "nodejs";

/** Reverse a capitalization: mirror journal, created draft assets removed, record reopened. */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "constructionInProgress",
  params: z.object({ id }),
  body: z.strictObject({ date: calendarDate("date"), reason: reasonText }),
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: capitalizationId } = await params;
    try {
      return NextResponse.json(
        await reverseCipCapitalization(gate.user.orgId, {
          capitalizationId,
          date: input.date,
          reason: input.reason,
          actorId: gate.user.id,
          allowedSubsidiaryIds: scopeOf(gate),
        }),
      );
    } catch (error) {
      // The mirror journal can meet the kernel's own posting refusals.
      return apiErrorResponse(error, { safeStatus: 422 });
    }
  },
});
