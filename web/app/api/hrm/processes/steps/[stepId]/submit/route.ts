import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { submitChecklistStepApproval } from "@openbooks/engine/hrm/processes";
import { guardPermission } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { processErrorResponse } from "../../../_lib";
import { completeStepBody } from "../../../bodies";

export const runtime = "nodejs";

/**
 * Complete one checklist step. Managers (hrm.process.manage) and the step's
 * own employee owner both arrive here — the service tells them apart, so
 * this route gates on the read grant and lets the service refuse strangers
 * with the remedy intact. Self-service readers (hrm.self.read) pass the
 * gate too: the /me checklists surface completes through this same
 * endpoint, and the service's ownership check (not this gate) is what
 * refuses a stranger — a widened gate with an unchanged refusal.
 */
async function authorizeChecklistActor() {
  const processGate = await guardPermission("hrm.process.read");
  if (!(processGate instanceof NextResponse)) return processGate;
  return guardPermission("hrm.self.read");
}

export const POST = defineRoute({
  authorize: () => authorizeChecklistActor(),
  feature: "hrm",
  params: z.object({ stepId: z.string().min(1) }),
  body: completeStepBody,
  invalidBodyStatus: 400,
  handler: async ({ authz: gate, params: routeParams, body: body }) => {
    const { stepId } = routeParams;
    if (!isUuid(stepId))
      return NextResponse.json({ error: "step id must be a uuid" }, { status: 400 });

    try {
      await submitChecklistStepApproval({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        stepId,
        ...body,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return processErrorResponse(e);
    }
  },
});
