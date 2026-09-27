import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  getGoal,
  setGoalStatus,
  updateGoalProgress,
} from "@openbooks/engine/src/hrm/performance/goals.ts";
import { isUuid } from "../../../../../lib/list-params";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchGoalBody } from "../../goals/bodies";
/**
 * One goal: GET resolves the goal with its progress evidence through the
 * goal read scope (subject, manager as of today, or HR); PATCH records
 * progress or moves to achieved/missed/cancelled through an
 * action-discriminated body. The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  feature: "hrm",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz, params }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid goal" }, { status: 400 });
    try {
      const detail = await getGoal({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        goalId: id,
      });
      return NextResponse.json(detail);
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
export const PATCH = defineRoute({
  public: "session",
  feature: "hrm",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz, params }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid goal" }, { status: 400 });
    const parsedBody = await parseJsonBody(req, patchGoalBody);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data;
    const base = {
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      goalId: id,
    };
    try {
      if (body.action === "progress") {
        const goal = await updateGoalProgress({
          ...base,
          progressPercent: body.progressPercent,
          note: body.note ?? null,
        });
        return NextResponse.json({ goal });
      }
      const goal = await setGoalStatus({
        ...base,
        status:
          body.action === "achieve"
            ? "achieved"
            : body.action === "miss"
              ? "missed"
              : "cancelled",
        ...(body.action === "achieve" ? {} : { note: body.note }),
      });
      return NextResponse.json({ goal });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
