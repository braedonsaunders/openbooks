import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { electMyBenefit } from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { meErrorResponse } from "../../_lib";
import { electBenefitBody } from "../../bodies";
/**
 * Elect coverage from the Me workspace. The body names the employment,
 * plan, window, and dates; the engine proves the employment is the
 * caller's own and the window is open over it — another person's
 * employment id and a closed window are both refused by name.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrm",
  body: electBenefitBody,
  handler: async ({ request: _req, authz: gate, body }) => {
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
  },
});
