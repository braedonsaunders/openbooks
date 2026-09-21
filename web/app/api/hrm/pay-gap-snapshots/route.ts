import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  computeGapSnapshot,
  latestGapSnapshot,
} from "@openbooks/engine/src/hrm/compensation/pay-transparency.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { compensationErrorResponse } from "../compensation/_lib";
import { generateSnapshotBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Pay-gap snapshots. GET reads the latest frozen snapshot; POST
 * computes one from payroll truth (effective rates through the wage
 * rate service, never bands). Both ride comp.manage — equity figures
 * are HR-only. The client checks res.ok before parsing.
 */
export async function GET() {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmPayTransparency"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const snapshot = await latestGapSnapshot({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ snapshot });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmPayTransparency"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, generateSnapshotBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const snapshot = await computeGapSnapshot({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      asOf: body.asOf,
      groupA: body.groupA,
      groupB: body.groupB,
    });
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
