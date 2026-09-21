import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  declineOffer,
  sendOffer,
  withdrawOffer,
} from "@openbooks/engine/src/hrm/recruiting/offers.ts";
import { acceptOfferAsHire } from "@openbooks/engine/src/hrm/recruiting/hire.ts";
import { getOfferDetail } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";
import { patchOfferBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One offer: GET resolves the drawer with the reader-reported
 * (expiry-computed) status; PATCH sends, accepts, declines, or withdraws —
 * through an action-discriminated body. Accepting IS the hire: one
 * transaction creating the employee party, filing the hire change request
 * through Flows, and filling the requisition — any refusal rolls the whole
 * hire back.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid offer" }, { status: 400 });
  try {
    const offer = await getOfferDetail({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      offerId: id,
    });
    return NextResponse.json({ offer });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid offer" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchOfferBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    if (body.action === "send") {
      const offer = await sendOffer({ orgId: gate.user.orgId, actorId: gate.user.id, offerId: id });
      return NextResponse.json({ offer });
    }
    if (body.action === "accept") {
      const hire = await acceptOfferAsHire({ orgId: gate.user.orgId, actorId: gate.user.id, offerId: id });
      return NextResponse.json({ hire });
    }
    if (body.action === "decline") {
      const offer = await declineOffer({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        offerId: id,
        reason: body.reason,
      });
      return NextResponse.json({ offer });
    }
    const offer = await withdrawOffer({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      offerId: id,
      reason: body.reason,
    });
    return NextResponse.json({ offer });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
