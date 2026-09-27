import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { createOffer } from "@openbooks/engine/src/hrm/recruiting/offers.ts";

import { recruitingErrorResponse } from "../_lib";
import { createOfferBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offers collection: POST drafts the terms on an active application (manage
 * gate in the service). At most one live offer stands per application — a
 * second drafts only after the first is sent past, withdrawn, or expired.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: createOfferBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const offer = await createOffer({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        applicationId: body.applicationId,
        positionId: body.positionId,
        employerSubsidiaryId: body.employerSubsidiaryId,
        departmentId: body.departmentId,
        jobTitle: body.jobTitle,
        employmentKind: body.employmentKind,
        proposedStartOn: body.proposedStartOn,
        compensationAmount: body.compensationAmount,
        compensationCurrency: body.compensationCurrency,
        compensationBasis: body.compensationBasis,
        expiresOn: body.expiresOn,
      });
      return NextResponse.json({ offer }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
