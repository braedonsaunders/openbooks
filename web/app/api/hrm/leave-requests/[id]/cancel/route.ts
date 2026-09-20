import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { cancelLeaveRequest } from "@openbooks/engine/src/hrm/leave.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { leaveErrorResponse } from "../../_lib";
import { leaveDecisionBody } from "../../bodies";

export const runtime = "nodejs";

/**
 * Cancel an approved request, with a reason: reverses absences and voids
 * pending inputs. Cancelling a request a committed run already consumed is
 * refused with the retro remedy — a paid row is never flipped to voided.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.leave.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "request id must be a uuid" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, leaveDecisionBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const request = await cancelLeaveRequest({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requestId: id,
      reason: parsedBody.data.reason,
    });
    return NextResponse.json({ request });
  } catch (e) {
    return leaveErrorResponse(e);
  }
}
