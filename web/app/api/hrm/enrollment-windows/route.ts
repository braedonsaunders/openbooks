import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createEnrollmentWindow,
} from "@openbooks/engine/src/hrm/benefits/windows.ts";
import { listEnrollmentWindows } from "@openbooks/engine/src/hrm/benefits/benefits-read.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { benefitsErrorResponse } from "../benefits/_lib";
import { createWindowBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Enrollment windows: GET lists (optionally segmented by status through
 * the shared filter-chips value), POST creates a draft. Opening and
 * closing ride [id]/open and [id]/close.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.benefits.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status !== null && status !== "draft" && status !== "open" && status !== "closed") {
    return NextResponse.json({ error: "unknown status" }, { status: 400 });
  }
  try {
    const windows = await listEnrollmentWindows(db, gate.user.orgId, gate.user.id, {
      ...(status ? { status } : {}),
    });
    return NextResponse.json({ windows });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.benefits.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createWindowBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const window = await createEnrollmentWindow({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      name: body.name,
      kind: body.kind,
      opensOn: body.opensOn,
      closesOn: body.closesOn,
      planYearStartOn: body.planYearStartOn,
      employerSubsidiaryId: body.employerSubsidiaryId ?? null,
      departmentId: body.departmentId ?? null,
    });
    return NextResponse.json({ window });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
