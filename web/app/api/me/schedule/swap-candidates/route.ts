import { isUuid } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { listSwapCandidates } from "@openbooks/engine/schedule-boards/requests";

/** Colleagues' published future shifts on the same board that could be swapped with one of the person's shifts. */
export const GET = defineRoute({
  permission: "hrm.self.request",
  feature: "hrmShiftPlanning",
  handler: async ({ request, authz }) => {
    const entryId = new URL(request.url).searchParams.get("entryId");
    if (!isUuid(entryId)) return notFound("record");
    return NextResponse.json({
      candidates: await listSwapCandidates({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        entryId,
      }),
    });
  },
});
