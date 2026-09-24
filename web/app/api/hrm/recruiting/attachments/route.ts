import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { attachCandidate } from "@openbooks/engine/src/hrm/recruiting/applications.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { attachCandidateBody } from "./bodies";

/**
 * Attach a prospect to an open requisition in ONE server call: the
 * candidate row (or email-dedupe merge) and the application row commit in
 * a single transaction. A failed attach stores nothing, so the prospect
 * can never be orphaned the way the old two-POST island left it when the
 * application POST failed.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, attachCandidateBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
