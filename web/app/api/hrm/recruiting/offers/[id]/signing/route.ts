import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sendOfferLink, voidOfferSignature } from "@openbooks/engine/src/hrm/recruiting/offers-signing.ts";
import { guardPermission } from "../../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../../lib/features";
import { recruitingErrorResponse } from "../../../_lib";
import { offerSigningBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offer signing desk: POST send-link emails the sessionless signing link,
 * POST void pulls an unsigned letter (manage gate in the service). 404s
 * while hrm, hrmRecruiting, or hrmOfferSigning is off.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmOfferSigning"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, offerSigningBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "send-link") {
      const link = await sendOfferLink({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        offerId: id,
        candidateEmail: body.candidateEmail,
        candidateName: body.candidateName,
      });
      return NextResponse.json({ link }, { status: 201 });
    }
    await voidOfferSignature({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      offerId: id,
      reason: body.reason,
    });
    return NextResponse.json({ voided: id });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
