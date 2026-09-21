import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { closeSurvey, getSurvey, openSurvey } from "@openbooks/engine/src/hrm/surveys/surveys.ts";
import { guardPermission } from "../../../../../lib/authz";
import { deliverSurveyInvitations } from "../../../../../lib/hrm/document-delivery";
import { hrmDocumentsErrorResponse } from "../../documents/_lib";
import { gateSurveys, resolveAppBaseUrl } from "../route";
import { openSurveyBody } from "../bodies";

/**
 * GET one survey (authoring view). POST with { action: "open", partyIds }
 * opens it and delivers invitations; POST with { action: "close" } freezes
 * it. Results live on [id]/results — aggregate only, never links.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.surveys.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateSurveys(gate.user.orgId);
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const survey = await getSurvey({ orgId: gate.user.orgId, actorId: gate.user.id, surveyId: id });
    return NextResponse.json({ survey });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.surveys.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateSurveys(gate.user.orgId);
  if (off) return off;
  const params = new URL(req.url).searchParams;
  const action = params.get("action") ?? "open";
  try {
    const { id } = await ctx.params;
    if (action === "close") {
      const survey = await closeSurvey({ orgId: gate.user.orgId, actorId: gate.user.id, surveyId: id });
      return NextResponse.json({ survey });
    }
    if (action !== "open") {
      return NextResponse.json({ error: "action must be open or close" }, { status: 400 });
    }
    const parsedBody = await parseJsonBody(req, openSurveyBody);
    if (!parsedBody.ok) return parsedBody.response;
    const { survey, deliveries } = await openSurvey({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      surveyId: id,
      partyIds: parsedBody.data.partyIds,
    });
    const results = await deliverSurveyInvitations({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      appBaseUrl: resolveAppBaseUrl(req),
      surveyName: survey.name,
      anonymity: survey.anonymity,
      closesDate: survey.closesAt ?? undefined,
      recipients: deliveries,
    });
    return NextResponse.json({
      survey,
      deliveries: deliveries.map((d) => ({
        invitationId: d.invitationId,
        partyId: d.partyId,
        respondUrl: `${resolveAppBaseUrl(req).replace(/\/$/, "")}/survey/${d.token}`,
        notified: results.find((r) => r.partyId === d.partyId)?.notified ?? false,
        emailed: results.find((r) => r.partyId === d.partyId)?.emailed ?? false,
        emailSkippedReason: results.find((r) => r.partyId === d.partyId)?.emailSkippedReason ?? null,
      })),
    });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
