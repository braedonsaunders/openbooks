import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createOffer } from "@openbooks/engine/src/hrm/recruiting/offers.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createOfferBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offers collection: POST drafts the terms on an active application (manage
 * gate in the service). At most one live offer stands per application — a
 * second drafts only after the first is sent past, withdrawn, or expired.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createOfferBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
