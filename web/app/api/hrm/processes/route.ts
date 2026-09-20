import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listProcesses, type ProcessSegment } from "@openbooks/engine/src/hrm/processes-read.ts";
import { openProcess } from "@openbooks/engine/src/hrm/processes.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { processErrorResponse } from "./_lib";
import { openProcessBody } from "./bodies";

export const runtime = "nodejs";

const SEGMENTS = ["open", "overdue", "completed", "cancelled"] as const;

/**
 * Process checklists collection. GET lists this org's processes behind the
 * HRM feature switch and the process read grant (subsidiary scope applied
 * per row in the service); POST opens a checklist for an employment
 * (process manage gate in the service, with its no-live-version and
 * duplicate-open refusals intact).
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.process.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const segment = url.searchParams.get("segment") ?? "open";
  if (!(SEGMENTS as readonly string[]).includes(segment)) {
    return NextResponse.json({ error: "segment must be one of open, overdue, completed, cancelled" }, { status: 400 });
  }
  const employmentId = url.searchParams.get("employment");
  if (employmentId !== null && !isUuid(employmentId)) {
    return NextResponse.json({ error: "employment must be a uuid" }, { status: 400 });
  }
  try {
    const processes = await listProcesses({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      segment: segment as ProcessSegment,
    });
    return NextResponse.json({
      processes: employmentId === null ? processes : processes.filter((p) => p.employmentId === employmentId),
    });
  } catch (e) {
    return processErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.process.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, openProcessBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const process = await openProcess({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      kind: body.kind,
      effectiveDate: body.effectiveDate,
      ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
    });
    return NextResponse.json({ process }, { status: 201 });
  } catch (e) {
    return processErrorResponse(e);
  }
}
