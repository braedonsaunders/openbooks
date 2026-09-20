import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createGoal } from "@openbooks/engine/src/hrm/performance/goals.ts";
import { listGoals } from "@openbooks/engine/src/hrm/performance/performance-read.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createGoalBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Goals. GET lists across the actor's visible employments (own, managed,
 * or HR scope — narrowed by ?employmentId); POST sets a goal on an
 * employment (subject-or-HR authority in the service). The client checks
 * res.ok before parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const employmentId = new URL(req.url).searchParams.get("employmentId");
  if (employmentId !== null && !isUuid(employmentId)) {
    return NextResponse.json({ error: "employmentId must be a uuid" }, { status: 400 });
  }
  try {
    const goals = await listGoals({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      ...(employmentId ? { employmentId } : {}),
    });
    return NextResponse.json({ goals });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createGoalBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const goal = await createGoal({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      employmentId: body.employmentId,
      title: body.title,
      description: body.description ?? null,
      dueOn: body.dueOn ?? null,
      weight: body.weight ?? null,
      cycleId: body.cycleId ?? null,
    });
    return NextResponse.json({ goal }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
