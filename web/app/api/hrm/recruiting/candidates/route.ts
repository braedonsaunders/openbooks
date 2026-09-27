import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { createCandidate } from "@openbooks/engine/src/hrm/recruiting/candidates.ts";

import { recruitingErrorResponse } from "../_lib";
import { createCandidateBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Candidates collection: POST authors a prospect (manage gate in the
 * service). A duplicate email refuses unless mergeInto names the survivor —
 * then no record is created and the caller attaches to the existing
 * candidate. PII never leaves through here without the read grant on the
 * follow-up reads.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  body: createCandidateBody,
  handler: async ({ authz: gate, body: body }) => {
    try {
      const { candidate, mergedInto } = await createCandidate({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        displayName: body.displayName,
        email: body.email,
        phone: body.phone,
        source: body.source,
        sourceDetail: body.sourceDetail,
        resumeAttachmentId: body.resumeAttachmentId,
        isInternal: body.isInternal,
        notes: body.notes,
        mergeInto: body.mergeInto,
      });
      return NextResponse.json({ candidate, mergedInto }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
