import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { proposeFirstEmployment } from "@openbooks/engine/src/hrm/first-employment.ts";
import { changeRequestErrorResponse } from "../change-requests/_lib";
import { hireEmploymentBody } from "./bodies";

/**
 * Employments collection. POST records a person's FIRST employment — the
 * Hire action for employee parties that hold no employment record. The
 * engine mints the reserved identity and files the hire through the
 * existing change-request service (a configured approval flow decides it;
 * a flow with the apply-without-approval outcome applies it at once),
 * audited and effective-dated. Later episodes ride the change-request
 * routes against the employment this call returns — never a second POST
 * here.
 */
export const POST = defineRoute({
  permission: "hrm.employment.manage",
  feature: "hrm",
  body: hireEmploymentBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const hire = await proposeFirstEmployment({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        workerPartyId: body.workerPartyId,
        employerSubsidiaryId: body.employerSubsidiaryId,
        ...(body.status === undefined ? {} : { status: body.status }),
        effectiveFrom: body.effectiveFrom,
        ...(body.effectiveTo === undefined ? {} : { effectiveTo: body.effectiveTo }),
        reason: body.reason,
        ...(body.action === undefined ? {} : { action: body.action }),
        ...(body.reasonCode === undefined ? {} : { reasonCode: body.reasonCode }),
      });
      return NextResponse.json(
        {
          employment: { id: hire.employmentId },
          request: { id: hire.changeRequestId, status: hire.status },
          applied: hire.applied,
        },
        { status: 201 },
      );
    } catch (e) {
      return changeRequestErrorResponse(e);
    }
  },
});
