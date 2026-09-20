import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listExitRecords, recordExit } from "@openbooks/engine/src/hrm/performance/exits.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { recordExitBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Exit records. GET lists through the retention read gate (HR only,
 * narrowed by ?employmentId); POST records the exit for a terminated
 * employment (performance manage gate in the service — refused when the
 * employment has no termination version as of today). The client checks
 * res.ok before parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.retention.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const employmentId = new URL(req.url).searchParams.get("employmentId");
  if (employmentId !== null && !isUuid(employmentId)) {
    return NextResponse.json({ error: "employmentId must be a uuid" }, { status: 400 });
  }
  try {
    const exits = await listExitRecords({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...(employmentId ? { employmentId } : {}),
    });
    return NextResponse.json({ exits });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request) {
  // Recording stays HR: the manage grant at the route plus the
  // employment's employer scope in the service.
  const gate = await guardPermission("hrm.performance.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, recordExitBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const exit = await recordExit({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      terminationChangeId: body.terminationChangeId ?? null,
      reasonKind: body.reasonKind,
      isVoluntary: body.isVoluntary,
      isRegrettable: body.isRegrettable ?? null,
      wouldRehire: body.wouldRehire ?? null,
      interviewHeldOn: body.interviewHeldOn ?? null,
      interviewerPartyId: body.interviewerPartyId ?? null,
      destination: body.destination ?? null,
      notes: body.notes ?? null,
    });
    return NextResponse.json({ exit }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
