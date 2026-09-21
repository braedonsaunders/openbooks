import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listSurveys, saveSurvey } from "@openbooks/engine/src/hrm/surveys/surveys.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { saveSurveyBody } from "./bodies";

export async function gateSurveys(orgId: string): Promise<NextResponse | null> {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isFeatureEnabled(orgId, "hrmSurveys"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

export function resolveAppBaseUrl(req: Request): string {
  const env = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.surveys.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateSurveys(gate.user.orgId);
  if (off) return off;
  try {
    const status = new URL(req.url).searchParams.get("status") ?? undefined;
    const surveys = await listSurveys({ orgId: gate.user.orgId, actorId: gate.user.id, status });
    return NextResponse.json({ surveys });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.surveys.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateSurveys(gate.user.orgId);
  if (off) return off;
  const parsedBody = await parseJsonBody(req, saveSurveyBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
    return NextResponse.json({ survey }, { status: body.surveyId ? 200 : 201 });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
