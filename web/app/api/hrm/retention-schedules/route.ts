import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listSchedules, saveSchedule } from "@openbooks/engine/src/hrm/documents/retention.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { saveScheduleBody } from "./bodies";

async function gateRetention(orgId: string): Promise<NextResponse | null> {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isFeatureEnabled(orgId, "hrmDocuments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(orgId, "hrmDocumentRetention"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

export async function GET() {
  const gate = await guardPermission("hrm.documents.read");
  if (gate instanceof NextResponse) return gate;
  const off = await gateRetention(gate.user.orgId);
  if (off) return off;
  try {
    const schedules = await listSchedules({ orgId: gate.user.orgId, actorId: gate.user.id });
    return NextResponse.json({ schedules });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.documents.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateRetention(gate.user.orgId);
  if (off) return off;
  const parsedBody = await parseJsonBody(req, saveScheduleBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const schedule = await saveSchedule({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      scheduleId: body.scheduleId,
      categoryKey: body.categoryKey,
      retainYears: body.retainYears,
      fromEvent: body.fromEvent,
      action: body.action,
      isActive: body.isActive,
    });
    return NextResponse.json({ schedule }, { status: body.scheduleId ? 200 : 201 });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
