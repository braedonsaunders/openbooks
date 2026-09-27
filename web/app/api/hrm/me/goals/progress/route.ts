import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { updateMyGoalProgress } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { meErrorResponse } from "../../_lib";
import { goalProgressBody } from "../../bodies";
/**
 * Record progress on the caller's own goal with a note. The engine proves
 * the goal sits on the caller's own employment — another person's goal
 * id is refused, never moved.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrm",
  body: goalProgressBody,
  handler: async ({ request: req, authz: gate, body }) => {
    try {
      const goal = await updateMyGoalProgress({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        goalId: body.goalId,
        progressPercent: body.progressPercent,
        note: body.note,
      });
      return NextResponse.json({ goal });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
