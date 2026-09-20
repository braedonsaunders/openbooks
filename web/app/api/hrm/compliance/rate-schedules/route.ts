import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  addScheduleLine,
  createSchedule,
  listSchedules,
  resolveWage,
  updateScheduleScope,
} from "@openbooks/engine/src/hrm/construction/rates.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { constructionErrorResponse } from "../_lib";
import { addScheduleLineBody, createScheduleBody, resolveWageBody, updateScheduleScopeBody } from "../bodies";

export const runtime = "nodejs";

/** Rate schedules: prevailing-wage, union-agreement, org-declared. */
export async function GET() {
  const gate = await guardPermission("hrm.construction.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const schedules = await listSchedules(db, gate.user.orgId, gate.user.id);
    return NextResponse.json({ schedules });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.construction.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createScheduleBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const schedule = await createSchedule(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}

/** Schedule lines and single-day wage resolution share this route file. */
export async function PUT(req: Request) {
  const gate = await guardPermission("hrm.construction.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("resolve") === "1") {
    const parsedBody = await parseJsonBody(req, resolveWageBody);
    if (!parsedBody.ok) return parsedBody.response;
    try {
      const wage = await resolveWage(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        employmentId: parsedBody.data.employmentId,
        projectId: parsedBody.data.projectId ?? null,
        workedOn: parsedBody.data.workedOn,
      });
      return NextResponse.json({ wage });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  }
  if (url.searchParams.get("scope") === "1") {
    const scoped = await parseJsonBody(req, updateScheduleScopeBody);
    if (!scoped.ok) return scoped.response;
    try {
      const schedule = await updateScheduleScope(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        scheduleId: scoped.data.scheduleId,
        appliesTo: scoped.data.appliesTo ?? {},
      });
      return NextResponse.json({ schedule });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  }
  const parsedBody = await parseJsonBody(req, addScheduleLineBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const lineId = await addScheduleLine(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ lineId }, { status: 201 });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}
