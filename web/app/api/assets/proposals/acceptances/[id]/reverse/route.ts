import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { reverseAssetProposalAcceptance } from "@openbooks/engine/assets/asset-proposals";
import { calendarDate, id, reasonText, scopeOf } from "../../../../_depth";

export const runtime = "nodejs";

/**
 * Reverse an acceptance: post the mirror reclassification, remove the draft
 * assets it created and return its proposals to the queue.
 */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "assetProposals",
  params: z.object({ id }),
  body: z.strictObject({ date: calendarDate("date"), reason: reasonText }),
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: acceptanceId } = await params;
    try {
      return NextResponse.json(
        await reverseAssetProposalAcceptance(gate.user.orgId, {
          acceptanceId,
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
