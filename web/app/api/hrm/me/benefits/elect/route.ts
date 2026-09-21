import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { electMyBenefit } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { meErrorResponse } from "../../_lib";
import { electBenefitBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Elect coverage from the Me workspace. The body names the employment,
 * plan, window, and dates; the engine proves the employment is the
 * caller's own and the window is open over it — another person's
 * employment id and a closed window are both refused by name.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.self.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, electBenefitBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const enrollment = await electMyBenefit({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      planId: body.planId,
      windowId: body.windowId,
      coverageLevelKey: body.coverageLevelKey,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      lifeEventReason: body.lifeEventReason,
    });
    return NextResponse.json({ enrollment }, { status: 201 });
  } catch (e) {
    return meErrorResponse(e);
  }
}
