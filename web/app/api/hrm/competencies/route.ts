import { NextResponse } from "next/server";
import {
  addCompetencyLevel,
  createCompetency,
} from "@openbooks/engine/src/hrm/performance/competencies.ts";
import { getAuthz } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { addCompetencyLevelBody, createCompetencyBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmCompetencies"))
  );
}

/**
 * Competencies and their ranked levels. POST with a frameworkId creates
 * the competency; POST with a competencyId adds a ranked level
 * expectation. The client checks res.ok before parsing.
 */
export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // The request body is read exactly once, then matched against the two
  // shapes (a level carries competencyId; a competency carries
  // frameworkId) — reading twice would consume the stream.
  const raw: unknown = await req.json().catch(() => null);
  if (raw !== null && typeof raw === "object" && "competencyId" in raw) {
    const parsedLevel = addCompetencyLevelBody.safeParse(raw);
    if (!parsedLevel.success) {
      return NextResponse.json({ error: parsedLevel.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
    }
    try {
      const level = await addCompetencyLevel({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        competencyId: parsedLevel.data.competencyId,
        levelRank: parsedLevel.data.levelRank,
        label: parsedLevel.data.label,
        expectation: parsedLevel.data.expectation,
      });
      return NextResponse.json({ level }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  }
  const parsedBody = createCompetencyBody.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }
  const body = parsedBody.data;
  try {
    const competency = await createCompetency({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      frameworkId: body.frameworkId,
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      category: body.category ?? null,
    });
    return NextResponse.json({ competency }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
