import { NextResponse } from "next/server";
import { getSurveyResults } from "@openbooks/engine/src/hrm/surveys/responses.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../../documents/_lib";
import { gateSurveys } from "../../route";

/** Aggregate results only — the reader grants no path back to a respondent. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.surveys.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateSurveys(gate.user.orgId);
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const results = await getSurveyResults({ orgId: gate.user.orgId, actorId: gate.user.id, surveyId: id });
    return NextResponse.json({ results });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
