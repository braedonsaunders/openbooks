import { parseJsonBody } from "../../../../../../../lib/api/json";
import { NextResponse } from "next/server";
import { listInterviewSlots, proposeSlots } from "@openbooks/engine/src/hrm/recruiting/scheduling.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { proposeSlotsBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interview slots: GET lists the interview's slots, POST proposes a batch
 * from declared availability windows and mints the candidate self-booking
 * link (manage gate in the service). 404s while hrm, hrmRecruiting, or
 * hrmInterviewScheduling is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmInterviewScheduling");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  try {
    const slots = await listInterviewSlots({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      interviewId: id,
    });
    return NextResponse.json({ slots });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, proposeSlotsBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const result = await proposeSlots({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      interviewId: id,
      windows: body.windows,
      poolId: body.poolId,
      expiresAt: body.expiresAt,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
