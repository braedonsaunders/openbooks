import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createCycle,
  listCycles,
} from "@openbooks/engine/src/hrm/performance/review-cycles.ts";
import { listCycleProgress } from "@openbooks/engine/src/hrm/performance/performance-read.ts";
import { can, getAuthz, guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { performanceErrorResponse } from "./_lib";
import { createCycleBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Review cycles. GET lists with progress: HR readers (hrm.performance.read)
 * see every cycle with org-wide counts; a manager with reports and no grant
 * sees only the cycles they participate in, with counts over that slice
 * (the read service narrows every row to the actor's privacy scope). POST
 * opens a draft cycle (performance manage gate in the service).
 */
export async function GET() {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    if (can(authz, "hrm.performance.read")) {
      const cycles = await listCycles({ orgId: authz.user.orgId, actorId: authz.user.id });
      return NextResponse.json({ cycles });
    }
    const cycles = await listCycleProgress({ orgId: authz.user.orgId, actorId: authz.user.id });
    return NextResponse.json({ cycles });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.performance.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createCycleBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const cycle = await createCycle({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      templateId: body.templateId,
      name: body.name,
      periodStartOn: body.periodStartOn,
      periodEndOn: body.periodEndOn,
      selfDueOn: body.selfDueOn ?? null,
      managerDueOn: body.managerDueOn ?? null,
      appliesTo: body.appliesTo ?? {},
    });
    return NextResponse.json({ cycle }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
