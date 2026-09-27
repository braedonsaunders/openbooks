import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getSurveyResults } from "@openbooks/engine/src/hrm/surveys/responses.ts";
import { hrmDocumentsErrorResponse } from "../../../documents/_lib";
/** Aggregate results only — the reader grants no path back to a respondent. */
export const GET = defineRoute({
  permission: "hrm.surveys.manage",
  feature: "hrmSurveys",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    try {
      const { id } = params;
      const results = await getSurveyResults({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        surveyId: id,
      });
      return NextResponse.json({ results });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
