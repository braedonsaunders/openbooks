import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createSuccessionPlan,
  listSuccessionPlans,
  setSuccessionPlanStatus,
} from "@openbooks/engine/src/hrm/performance/talent.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createSuccessionPlanBody, patchSuccessionPlanBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmSuccession"))
  );
}

/**
 * Succession plans with ranked candidates. GET lists HR-only plans;
 * POST creates one per position; PATCH moves draft/active/archived.
 * There is no candidate self view. The client checks res.ok before
 * parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  void req;
  try {
    const plans = await listSuccessionPlans({ orgId: authz.user.orgId, actorId: authz.user.id });
    return NextResponse.json({ plans });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createSuccessionPlanBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const plan = await createSuccessionPlan({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      positionId: body.positionId,
      incumbentEmploymentId: body.incumbentEmploymentId ?? null,
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchSuccessionPlanBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    await setSuccessionPlanStatus({ orgId: authz.user.orgId, actorId: authz.user.id, id, status: parsedBody.data.status });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
