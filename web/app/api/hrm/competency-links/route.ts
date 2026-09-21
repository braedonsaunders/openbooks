import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  linkCompetency,
  setSectionCompetency,
} from "@openbooks/engine/src/hrm/performance/competencies.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { linkCompetencyBody } from "../competency-frameworks/bodies";

export const runtime = "nodejs";

/**
 * Competency links. POST links a competency to a job level, position,
 * or review template section (the target must exist — refused by name
 * otherwise), or attaches a competency to a template section so the
 * review renders its level expectations inline. The client checks
 * res.ok before parsing.
 */
export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmCompetencies"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, linkCompetencyBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "link") {
      await linkCompetency({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        competencyId: body.competencyId,
        targetKind: body.targetKind,
        targetId: body.targetId,
      });
      return NextResponse.json({ ok: true }, { status: 201 });
    }
    await setSectionCompetency({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      sectionId: body.sectionId,
      competencyId: body.competencyId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
