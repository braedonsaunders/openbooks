import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import {
  declineOffer,
  sendOffer,
  withdrawOffer,
} from "@openbooks/engine/src/hrm/recruiting/offers.ts";
import { acceptOfferAsHire } from "@openbooks/engine/src/hrm/recruiting/hire.ts";
import { getOfferDetail } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";

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
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid offer" }, { status: 400 });
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
  },
});

export const PATCH = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: patchOfferBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid offer" }, { status: 400 });

    try {
      if (body.action === "send") {
        const offer = await sendOffer({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          offerId: id,
        });
        return NextResponse.json({ offer });
      }
      if (body.action === "accept") {
        const hire = await acceptOfferAsHire({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          offerId: id,
        });
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
  },
});
