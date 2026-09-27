import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createGoal } from "@openbooks/engine/src/hrm/performance/goals.ts";
import { listGoals } from "@openbooks/engine/src/hrm/performance/performance-read.ts";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createGoalBody } from "./bodies";
/**
 * Goals. GET lists across the actor's visible employments (own, managed,
 * or HR scope — narrowed by ?employmentId); POST sets a goal on an
 * employment (subject-or-HR authority in the service). The client checks
 * res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  feature: "hrm",
  handler: async ({ request: req, authz }) => {
    const employmentId = new URL(req.url).searchParams.get("employmentId");
    if (employmentId !== null && !isUuid(employmentId)) {
      return NextResponse.json(
        { error: "employmentId must be a uuid" },
        { status: 400 },
      );
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
  },
});
export const POST = defineRoute({
  public: "session",
  feature: "hrm",
  handler: async ({ request: req, authz }) => {
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
  },
});
