import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createApplication } from "@openbooks/engine/src/hrm/recruiting/applications.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createApplicationBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Applications collection: POST attaches a candidate to an open requisition
 * at the funnel's first stage (manage gate in the service). The pair is
 * unique — a second attach refuses by name.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createApplicationBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const application = await createApplication({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requisitionId: body.requisitionId,
      candidateId: body.candidateId,
      merged: body.merged,
    });
    return NextResponse.json({ application }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
