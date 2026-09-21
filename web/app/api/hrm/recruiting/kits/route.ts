import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createKit, listKits } from "@openbooks/engine/src/hrm/recruiting/kits.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createKitBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interview-kit collection: GET lists kits, POST creates one (manage gate
 * in the service). 404s while hrm, hrmRecruiting, or hrmStructuredInterviews
 * is off — the Setup surface hides with the same switch.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmStructuredInterviews");
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
    const kits = await listKits({ orgId: gate.user.orgId, actorId: gate.user.id, includeInactive });
    return NextResponse.json({ kits });
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
  const parsedBody = await parseJsonBody(req, createKitBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const kit = await createKit({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      name: body.name,
      pipelineStageId: body.pipelineStageId,
      instructions: body.instructions,
      ratingScale: body.ratingScale,
    });
    return NextResponse.json({ kit }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
