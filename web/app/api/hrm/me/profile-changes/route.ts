import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { fileProfileChangeRequest } from "@openbooks/engine/src/hrm/self-service/profile-changes.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { meErrorResponse } from "../_lib";
import { fileProfileChangeBody } from "../bodies";

export const runtime = "nodejs";

/**
 * File a profile-change proposal for one's own party and submit it for HR
 * approval in one user action. The engine binds one of the actor's own
 * employments and re-resolves the edited party in-transaction — the body
 * carries no party id to forge.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.self.request");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, fileProfileChangeBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
