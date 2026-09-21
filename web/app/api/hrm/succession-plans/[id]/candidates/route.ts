import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  addSuccessionCandidate,
  removeSuccessionCandidate,
} from "@openbooks/engine/src/hrm/performance/talent.ts";
import { getAuthz } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { performanceErrorResponse } from "../../../review-cycles/_lib";
import { addSuccessionCandidateBody } from "../../../talent-reviews/bodies";
import { z } from "zod";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

const removeCandidateBody = z.object({ candidateId: z.string().refine(isUuid, "must be a valid id") });

/**
 * Ranked succession candidates on one plan. POST appends at the next
 * rank; PATCH with a candidateId removes. HR-only. The client checks
 * res.ok before parsing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmSuccession"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, addSuccessionCandidateBody);
  if (!parsedBody.ok) return parsedBody.response;
  const { id } = await ctx.params;
  try {
    const candidate = await addSuccessionCandidate({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      planId: id,
      employmentId: parsedBody.data.employmentId,
      readiness: parsedBody.data.readiness,
      notes: parsedBody.data.notes ?? null,
    });
    return NextResponse.json({ candidate }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (
    !(await isFeatureEnabled(authz.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmPerformance")) ||
    !(await isFeatureEnabled(authz.user.orgId, "hrmSuccession"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, removeCandidateBody);
  if (!parsedBody.ok) return parsedBody.response;
  const { id } = await ctx.params;
  try {
    await removeSuccessionCandidate({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      planId: id,
      candidateId: parsedBody.data.candidateId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
