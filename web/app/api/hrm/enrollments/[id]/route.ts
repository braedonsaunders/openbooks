import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  approveEnrollment,
  cancelEnrollment,
  changeEnrollment,
  endEnrollment,
} from "@openbooks/engine/src/hrm/benefits/enrollments.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { enrollmentPatchBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One enrolment's lifecycle: approve, change (end plus open anew), end
 * with a reason, or cancel. All four need hrm.benefits.manage; the engine
 * rechecks the employment scope inside the transaction.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "enrollment id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, enrollmentPatchBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const base = { orgId: gate.user.orgId, actorId: gate.user.id, enrollmentId: id };
  try {
    switch (body.action) {
      case "approve": {
        const enrollment = await approveEnrollment(base);
        return NextResponse.json({ enrollment });
      }
      case "change": {
        const enrollment = await changeEnrollment({
          ...base,
          changeDate: body.changeDate,
          coverageLevelKey: body.coverageLevelKey ?? undefined,
          reason: body.reason,
        });
        return NextResponse.json({ enrollment });
      }
      case "end": {
        const enrollment = await endEnrollment({
          ...base,
          endedOn: body.endedOn ?? null,
          reason: body.reason,
        });
        return NextResponse.json({ enrollment });
      }
      case "cancel": {
        const enrollment = await cancelEnrollment({ ...base, reason: body.reason });
        return NextResponse.json({ enrollment });
      }
    }
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
