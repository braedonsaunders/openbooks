import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { fileLeaveRequest } from "@openbooks/engine/src/hrm/leave.ts";
import {
  listLeaveRequests,
  myLeaveRequests,
} from "@openbooks/engine/src/hrm/leave-read.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { leaveErrorResponse } from "./_lib";
import { fileLeaveRequestBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Leave requests: GET lists one employment's requests (or the caller's own
 * when employmentId is "mine"), POST files a draft. Self-service files only
 * against the caller's own employment — the engine scopes the subject, and
 * the list for "mine" never accepts a caller-supplied worker.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.leave.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const employmentId = url.searchParams.get("employmentId");
  const status = url.searchParams.get("status");
  const statuses = ["draft", "submitted", "approved", "rejected", "withdrawn", "cancelled"];
  if (status !== null && !statuses.includes(status)) {
    return NextResponse.json({ error: "unknown status" }, { status: 400 });
  }
  try {
    if (employmentId === "mine" || employmentId === null) {
      if (status !== null) {
        return NextResponse.json({ error: "status filtering on the self-service inbox is not supported" }, { status: 400 });
      }
      const requests = await myLeaveRequests({ orgId: gate.user.orgId, actorId: gate.user.id });
      return NextResponse.json({ requests });
    }
    if (!isUuid(employmentId)) return NextResponse.json({ error: "employment id must be a uuid" }, { status: 400 });
    const requests = await listLeaveRequests({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId,
      ...(status ? { status } : {}),
    });
    return NextResponse.json({ requests });
  } catch (e) {
    return leaveErrorResponse(e);
  }
}

export async function POST(req: Request) {
  // Filing needs the request grant; on-behalf filing additionally needs
  // hrm.leave.manage, enforced inside the engine per employment.
  const gate = await guardPermission("hrm.leave.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, fileLeaveRequestBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const request = await fileLeaveRequest({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      leaveTypeId: body.leaveTypeId,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      hours: body.hours,
      reason: body.reason ?? null,
      onBehalf: body.onBehalf,
    });
    return NextResponse.json({ request });
  } catch (e) {
    return leaveErrorResponse(e);
  }
}
