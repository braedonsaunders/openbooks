import { NextResponse } from "next/server";
import { reissueInvitationToken } from "@openbooks/engine/src/hrm/surveys/responses.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../../../../documents/_lib";

/**
 * POST /api/hrm/surveys/invitations/[id]/reissue — re-mint one open
 * invitation's token for the invited party in-session and return the
 * fresh token for the /survey/[token] page. The service refuses
 * answered invitations, closed surveys, and anyone else's invitation.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.self.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmSurveys"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const { id } = await ctx.params;
    const { token, surveyId } = await reissueInvitationToken({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      invitationId: id,
    });
    return NextResponse.json({ token, surveyId });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
