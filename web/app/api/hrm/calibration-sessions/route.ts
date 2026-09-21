import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createCalibrationSession,
  listCalibrationSessions,
} from "@openbooks/engine/src/hrm/performance/calibration.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { createCalibrationSessionBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmCalibration"))
  );
}

/**
 * Calibration sessions. GET lists (narrowed by ?cycleId); POST creates
 * a draft over a cycle. HR-only. The client checks res.ok before
 * parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const cycleId = new URL(req.url).searchParams.get("cycleId");
  if (cycleId !== null && !isUuid(cycleId)) {
    return NextResponse.json({ error: "cycleId must be a uuid" }, { status: 400 });
  }
  try {
    const sessions = await listCalibrationSessions({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      ...(cycleId ? { cycleId } : {}),
    });
    return NextResponse.json({ sessions });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createCalibrationSessionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const session = await createCalibrationSession({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      cycleId: body.cycleId,
      name: body.name,
      scope: body.scope ?? null,
      facilitatorPartyId: body.facilitatorPartyId ?? null,
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
