import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createTalentPool, listTalentPools } from "@openbooks/engine/src/hrm/recruiting/pools.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { createTalentPoolBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Talent-pool collection: GET lists pools, POST creates one (manage gate
 * in the service). 404s while hrm, hrmRecruiting, or hrmTalentPool is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return false;
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmTalentPool");
}

export async function GET(_req: Request) {
  const gate = await guardPermission("hrm.recruiting.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await depthGate(gate.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const pools = await listTalentPools({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ pools });
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
  const parsedBody = await parseJsonBody(req, createTalentPoolBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const pool = await createTalentPool({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      name: body.name,
      description: body.description,
    });
    return NextResponse.json({ pool }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
