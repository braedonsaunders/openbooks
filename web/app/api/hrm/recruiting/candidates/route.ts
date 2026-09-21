import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createCandidate } from "@openbooks/engine/src/hrm/recruiting/candidates.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
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
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever
  // hrm is on) — the wrap is additive and changes nothing by default.
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm")) || !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createCandidateBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
}
