import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { reissueInvitationToken } from "@openbooks/engine/src/hrm/surveys/responses.ts";
import { hrmDocumentsErrorResponse } from "../../../../documents/_lib";
/**
 * POST /api/hrm/surveys/invitations/[id]/reissue — re-mint one open
 * invitation's token for the invited party in-session and return the
 * fresh token for the /survey/[token] page. The service refuses
 * answered invitations, closed surveys, and anyone else's invitation.
 */
export const POST = defineRoute({
  permission: "hrm.self.read",
  feature: "hrmSurveys",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    try {
      const { id } = params;
      const { token, surveyId } = await reissueInvitationToken({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        invitationId: id,
      });
      return NextResponse.json({ token, surveyId });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
