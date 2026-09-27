import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { createRequisition } from "@openbooks/engine/src/hrm/recruiting/requisitions.ts";
import { listRequisitions } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";

import { recruitingErrorResponse } from "../_lib";
import { createRequisitionBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Requisitions collection. GET lists through the aggregate read gate
 * (optional status segment); POST drafts an opening (manage gate against
 * the declared employer in the service). Whole-call denials are HTTP errors
 * with `{ error }` bodies — the client checks res.ok before parsing.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  handler: async ({ request: req, authz: gate }) => {
    const status = new URL(req.url).searchParams.get("status");
    if (
      status !== null &&
      !["draft", "open", "on_hold", "filled", "cancelled"].includes(status)
    ) {
      return NextResponse.json(
        { error: "unknown requisition status" },
        { status: 400 },
      );
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
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: createRequisitionBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
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
  },
});
