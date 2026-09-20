import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { changeMyBenefit } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { meErrorResponse } from "../../_lib";
import { changeBenefitBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Change an active election from a date inside an open window covering
 * the caller's employment. The body names the enrollment; the engine
 * proves it sits on the caller's own employment and the change date
 * sits inside an open window — both refusals name the remedy.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.self.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, changeBenefitBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const enrollment = await changeMyBenefit({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      enrollmentId: body.enrollmentId,
      changeDate: body.changeDate,
      coverageLevelKey: body.coverageLevelKey,
      reason: body.reason,
    });
    return NextResponse.json({ enrollment });
  } catch (e) {
    return meErrorResponse(e);
  }
}
