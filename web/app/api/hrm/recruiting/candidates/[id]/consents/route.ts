import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  recordConsent,
  withdrawConsent,
} from "@openbooks/engine/src/hrm/recruiting/retention.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { recordConsentBody, withdrawConsentBody } from "./bodies";
import { z } from "zod";

export const runtime = "nodejs";

const consentActionBody = z.union([withdrawConsentBody, recordConsentBody]);

/**
 * Candidate consents: POST records (or re-grants) consent for a purpose,
 * POST with action withdraw withdraws it (the row stays as evidence).
 * 404s while HRM or Recruiting is off.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: consentActionBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      if ("action" in body && body.action === "withdraw") {
        await withdrawConsent({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          candidateId: id,
          purpose: body.purpose,
        });
        return NextResponse.json({ withdrawn: id });
      }
      const consent = await recordConsent({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        candidateId: id,
        purpose: body.purpose,
        source: "source" in body ? body.source : undefined,
        expiresAt: "expiresAt" in body ? body.expiresAt : undefined,
      });
      return NextResponse.json({ consent }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
