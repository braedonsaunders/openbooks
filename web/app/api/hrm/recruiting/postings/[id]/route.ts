import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { closePosting, pausePosting } from "@openbooks/engine/src/hrm/recruiting/postings.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../../lib/features";
import { recruitingErrorResponse } from "../../_lib";
import { transitionPostingBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One job-board posting: POST pause/close (manage gate in the service).
 * Closed postings stay closed. 404s while hrm, hrmRecruiting, or
 * hrmJobBoards is off.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (
    !(await isFeatureEnabled(gate.user.orgId, "hrm")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmRecruiting")) ||
    !(await isFeatureEnabled(gate.user.orgId, "hrmJobBoards"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, transitionPostingBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const posting =
      parsedBody.data.action === "pause"
        ? await pausePosting({ orgId: gate.user.orgId, actorId: gate.user.id, postingId: id })
        : await closePosting({ orgId: gate.user.orgId, actorId: gate.user.id, postingId: id });
    return NextResponse.json({ posting });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
