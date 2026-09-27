import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  sendOfferLink,
  voidOfferSignature,
} from "@openbooks/engine/src/hrm/recruiting/offers-signing.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { offerSigningBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Offer signing desk: POST send-link emails the sessionless signing link,
 * POST void pulls an unsigned letter (manage gate in the service). 404s
 * while hrm, hrmRecruiting, or hrmOfferSigning is off.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmOfferSigning",
  params: z.object({ id: z.string().min(1) }),
  body: offerSigningBody,
  handler: async ({
    request: req,
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

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
  },
});
