import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { submitResponse } from "@openbooks/engine/src/hrm/surveys/responses.ts";
import { hashHrmToken, verifySurveyInvitationToken } from "@openbooks/engine/src/hrm/documents/tokens.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { hrmDocumentsErrorResponse } from "../../../hrm/documents/_lib";
import { submitAnswersBody } from "../../../hrm/surveys/bodies";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";

/**
 * Public survey response endpoint — invitation-token authenticated, no
 * session. GET returns the survey cards (name, anonymity, questions
 * without results) so the form can render. POST submits one response;
 * the token is consumed on submit and replays are refused. No
 * feature-gate here: a link HR sent must explain itself even after the
 * switch flips.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const claims = verifySurveyInvitationToken(token);
    if (!claims) {
      return NextResponse.json({ error: "this survey link is invalid or expired — ask HR for a fresh invitation" }, { status: 403 });
    }
    const survey = await withOrgTransaction(claims.orgId, async () => {
      const row = (await db.execute<{
        id: string;
        name: string;
        kind: string;
        anonymity: string;
        status: string;
        closes_at: string | null;
      }>(sql`
        select s.id, s.name, s.kind, s.anonymity, s.status, s.closes_at::text as closes_at
          from hrm_survey_invitations i
          join hrm_surveys s on s.org_id = i.org_id and s.id = i.survey_id
         where i.token_hash = ${hashHrmToken(token)}
      `)).rows[0];
      if (!row) {
        throw Object.assign(new Error("this survey link is no longer available — ask HR for a fresh invitation"), { status: 403 });
      }
      const questions = (await db.execute<{ id: string; kind: string; prompt: string; options: unknown }>(sql`
        select id, kind, prompt, options from hrm_survey_questions
         where org_id = ${claims.orgId} and survey_id = ${row.id}
         order by position
      `)).rows;
      return { ...row, questions };
    });
    return NextResponse.json({ survey });
  } catch (e) {
    if (e instanceof Error && (e as { status?: number }).status === 403) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    return hrmDocumentsErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const parsedBody = await parseJsonBody(req, submitAnswersBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const { token } = await ctx.params;
    const claims = verifySurveyInvitationToken(token);
    if (!claims) {
      return NextResponse.json({ error: "this survey link is invalid or expired — ask HR for a fresh invitation" }, { status: 403 });
    }
    const today = await businessToday(claims.orgId);
    const result = await submitResponse({ token, answers: parsedBody.data.answers, today });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
