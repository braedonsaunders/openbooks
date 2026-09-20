import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createRequisition } from "@openbooks/engine/src/hrm/recruiting/requisitions.ts";
import { listRequisitions } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createRequisitionBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Requisitions collection. GET lists through the aggregate read gate
 * (optional status segment); POST drafts an opening (manage gate against
 * the declared employer in the service). Whole-call denials are HTTP errors
 * with `{ error }` bodies — the client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const status = new URL(req.url).searchParams.get("status");
  if (status !== null && !["draft", "open", "on_hold", "filled", "cancelled"].includes(status)) {
    return NextResponse.json({ error: "unknown requisition status" }, { status: 400 });
  }
  try {
    const requisitions = await listRequisitions({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...(status ? { status } : {}),
    });
    return NextResponse.json({ requisitions });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createRequisitionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const requisition = await createRequisition({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      title: body.title,
      positionId: body.positionId,
      employerSubsidiaryId: body.employerSubsidiaryId,
      departmentId: body.departmentId,
      locationId: body.locationId,
      hiringManagerPartyId: body.hiringManagerPartyId,
      recruiterUserId: body.recruiterUserId,
      headcount: body.headcount,
      employmentKind: body.employmentKind,
      targetStartOn: body.targetStartOn,
      compensation: body.compensation,
      pipelineTemplateId: body.pipelineTemplateId,
      description: body.description,
    });
    return NextResponse.json({ requisition }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
