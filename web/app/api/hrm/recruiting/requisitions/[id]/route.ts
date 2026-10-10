import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import {
  cancelRequisition,
  holdRequisition,
  openRequisition,
  resumeRequisition,
  reviseRequisition,
} from "@openbooks/engine/src/hrm/recruiting/requisitions.ts";
import { getRequisitionDetail } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";
import { patchRequisitionBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One requisition: GET resolves the drawer (pipeline chips, funnel,
 * applications) through the read service — which redacts candidate PII for
 * viewers without the read grant and admits the hiring manager on their own
 * openings; PATCH opens, holds, resumes, cancels, or revises the posting
 * content through an action-discriminated body (the fill rides hire, never
 * this endpoint).
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid requisition" },
        { status: 400 },
      );
    try {
      const requisition = await getRequisitionDetail({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: id,
      });
      return NextResponse.json({ requisition });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: patchRequisitionBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json(
        { error: "invalid requisition" },
        { status: 400 },
      );

    try {
      if (body.action === "open") {
        const requisition = await openRequisition({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          requisitionId: id,
          targetStartOn: body.targetStartOn,
          overEstablishment: body.overEstablishment,
        });
        return NextResponse.json({ requisition });
      }
      if (body.action === "hold") {
        const requisition = await holdRequisition({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          requisitionId: id,
          reason: body.reason,
        });
        return NextResponse.json({ requisition });
      }
      if (body.action === "revise") {
        const requisition = await reviseRequisition({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          requisitionId: id,
          expectedRevision: body.expectedRevision,
          title: body.title,
          employmentKind: body.employmentKind,
          compensation: body.compensation,
          description: body.description,
        });
        return NextResponse.json({ requisition });
      }
      if (body.action === "resume") {
        const requisition = await resumeRequisition({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          requisitionId: id,
          reason: body.reason,
        });
        return NextResponse.json({ requisition });
      }
      const requisition = await cancelRequisition({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: id,
        reason: body.reason,
      });
      return NextResponse.json({ requisition });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
