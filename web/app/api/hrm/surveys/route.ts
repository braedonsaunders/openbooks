import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listSurveys,
  saveSurvey,
} from "@openbooks/engine/src/hrm/surveys/surveys.ts";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { saveSurveyBody } from "./bodies";
export function resolveAppBaseUrl(req: Request): string {
  const env = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
export const GET = defineRoute({
  permission: "hrm.surveys.manage",
  feature: "hrmSurveys",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const status = new URL(req.url).searchParams.get("status") ?? undefined;
      const surveys = await listSurveys({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        status,
      });
      return NextResponse.json({ surveys });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.surveys.manage",
  feature: "hrmSurveys",
  body: saveSurveyBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const survey = await saveSurvey({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        surveyId: body.surveyId,
        name: body.name,
        kind: body.kind,
        anonymity: body.anonymity,
        opensAt: body.opensAt ?? null,
        closesAt: body.closesAt ?? null,
        audience: body.audience ?? {},
        recurrence: body.recurrence ?? null,
        minGroupSize: body.minGroupSize,
        questions: body.questions,
      });
      return NextResponse.json(
        { survey },
        { status: body.surveyId ? 200 : 201 },
      );
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
