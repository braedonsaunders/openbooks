import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { attachCandidate } from "@openbooks/engine/src/hrm/recruiting/applications.ts";

import { recruitingErrorResponse } from "../_lib";
import { attachCandidateBody } from "./bodies";

/**
 * Attach a prospect to an open requisition in ONE server call: the
 * candidate row (or email-dedupe merge) and the application row commit in
 * a single transaction. A failed attach stores nothing, so the prospect
 * can never be orphaned the way the old two-POST island left it when the
 * application POST failed.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: attachCandidateBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const attached = await attachCandidate({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: body.requisitionId,
        displayName: body.displayName,
        email: body.email,
        phone: body.phone,
        mergeInto: body.mergeInto,
      });
      return NextResponse.json({ attached }, { status: 201 });
    } catch (error) {
      return recruitingErrorResponse(error);
    }
  },
});
