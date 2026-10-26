import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { closeSurvey, getSurvey, openSurvey } from "@openbooks/engine/hrm/surveys/surveys";
import { deliverSurveyInvitations } from "@/lib/hrm/document-delivery";
import { hrmDocumentsErrorResponse } from "../../documents/_lib";
import { resolveAppBaseUrl } from "../route";
import { openSurveyBody } from "../bodies";
/**
 * GET one survey (authoring view). POST with { action: "open", partyIds }
 * opens it and delivers invitations; POST with { action: "close" } freezes
 * it. Results live on [id]/results — aggregate only, never links.
 */
export const GET = defineRoute({
  permission: "hrm.surveys.manage",
  feature: "hrmSurveys",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    try {
      const { id } = params;
      const survey = await getSurvey({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        surveyId: id,
      });
      return NextResponse.json({ survey });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.surveys.manage",
  feature: "hrmSurveys",
  params: z.object({ id: z.string() }),
  body: ({ request }) => {
    const action = new URL(request.url).searchParams.get("action") ?? "open";
    return action === "open" ? openSurveyBody : undefined;
  },
  handler: async ({ request: req, authz: gate, params, body }) => {
    const searchParams = new URL(req.url).searchParams;
    const action = searchParams.get("action") ?? "open";
    try {
      const { id } = params;
      if (action === "close") {
        const survey = await closeSurvey({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          surveyId: id,
        });
        return NextResponse.json({ survey });
      }
      if (action !== "open") {
        return NextResponse.json({ error: "action must be open or close" }, { status: 400 });
      }
      const { survey, deliveries } = await openSurvey({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        surveyId: id,
        partyIds: body.partyIds,
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
          emailSkippedReason:
            results.find((r) => r.partyId === d.partyId)?.emailSkippedReason ?? null,
        })),
      });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
