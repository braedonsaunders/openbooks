import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  listOneOnOnes,
  scheduleOneOnOne,
} from "@openbooks/engine/src/hrm/performance/one-on-ones.ts";
import { getAuthz } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { scheduleOneOnOneBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmOneOnOnes"))
  );
}

/**
 * 1:1s. GET lists the actor's visible 1:1s (the pair, the line manager,
 * or HR scope — narrowed by ?employmentId and ?status); POST schedules
 * one (either party may propose; a third party must manage the report).
 * The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await gated(authz.user.orgId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const params = new URL(req.url).searchParams;
  const employmentId = params.get("employmentId");
  const status = params.get("status");
  if (employmentId !== null && !isUuid(employmentId)) {
    return NextResponse.json({ error: "employmentId must be a uuid" }, { status: 400 });
  }
  if (status !== null && !["scheduled", "held", "skipped", "cancelled"].includes(status)) {
    return NextResponse.json({ error: "status must be scheduled, held, skipped, or cancelled" }, { status: 400 });
  }
  try {
    const ones = await listOneOnOnes({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      ...(employmentId ? { employmentId } : {}),
      ...(status ? { status: status as "scheduled" | "held" | "skipped" | "cancelled" } : {}),
    });
    return NextResponse.json({ oneOnOnes: ones });
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
  const parsedBody = await parseJsonBody(req, scheduleOneOnOneBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const one = await scheduleOneOnOne({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      managerEmploymentId: body.managerEmploymentId,
      reportEmploymentId: body.reportEmploymentId,
      scheduledAt: body.scheduledAt,
      recurrence: body.recurrence ?? null,
    });
    return NextResponse.json({ oneOnOne: one }, { status: 201 });
  } catch (e) {
    return performanceErrorResponse(e);
  }
}
