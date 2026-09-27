import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { fileProfileChangeRequest } from "@openbooks/engine/src/hrm/self-service/profile-changes.ts";
import { meErrorResponse } from "../_lib";
import { fileProfileChangeBody } from "../bodies";
/**
 * File a profile-change proposal for one's own party and submit it for HR
 * approval in one user action. The engine binds one of the actor's own
 * employments and re-resolves the edited party in-transaction — the body
 * carries no party id to forge.
 */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrm",
  body: fileProfileChangeBody,
  handler: async ({ request: req, authz: gate, body }) => {
    try {
      const { request } = await fileProfileChangeRequest({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: body.employmentId,
        changes: body.changes,
        reason: body.reason,
      });
      return NextResponse.json({ request }, { status: 201 });
    } catch (e) {
      return meErrorResponse(e);
    }
  },
});
