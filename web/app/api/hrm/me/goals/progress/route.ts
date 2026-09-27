import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { updateMyGoalProgress } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { meErrorResponse } from "../../_lib";
import { goalProgressBody } from "../../bodies";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

/**
 * Record progress on the caller's own goal with a note. The engine proves
 * the goal sits on the caller's own employment — another person's goal
 * id is refused, never moved.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.self.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return notFound("record");
  }
  const parsedBody = await parseJsonBody(req, goalProgressBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
