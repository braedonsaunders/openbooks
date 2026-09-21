import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listPostings, publishPosting } from "@openbooks/engine/src/hrm/recruiting/postings.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { publishPostingBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Job-board postings: GET lists (optionally per requisition), POST
 * publishes one board (manage gate in the service). 404s while hrm,
 * hrmRecruiting, or hrmJobBoards is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmJobBoards");
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const requisitionId = new URL(req.url).searchParams.get("requisitionId") ?? undefined;
    const postings = await listPostings({ orgId: gate.user.orgId, actorId: gate.user.id, requisitionId });
    return NextResponse.json({ postings });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.recruiting.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, publishPostingBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const posting = await publishPosting({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requisitionId: body.requisitionId,
      boardKey: body.boardKey,
    });
    return NextResponse.json({ posting }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
