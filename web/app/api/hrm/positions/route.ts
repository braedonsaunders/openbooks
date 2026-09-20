import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { createPosition } from "@openbooks/engine/src/hrm/positions.ts";
import { getVacancyAsOf } from "@openbooks/engine/src/hrm/positions-read.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { positionErrorResponse } from "./_lib";
import { createPositionBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Positions collection. GET reads the vacancy as of a date (position read
 * gate in the service, optional status segment); POST opens a position
 * (position manage gate in the service). Employment-to-position assignment
 * rides the change-request routes, never a new endpoint.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.position.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const rawDate = url.searchParams.get("effectiveDate");
  const effectiveDate = rawDate ?? (await businessToday(gate.user.orgId));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    return NextResponse.json({ error: "effectiveDate must be YYYY-MM-DD" }, { status: 400 });
  }
  if (status !== null && !["planned", "open", "filled", "frozen", "closed"].includes(status)) {
    return NextResponse.json({ error: "unknown position status" }, { status: 400 });
  }
  try {
    const vacancy = await getVacancyAsOf({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      effectiveDate,
      knownAt: new Date().toISOString(),
      ...(status ? { status } : {}),
    });
    return NextResponse.json({ vacancy });
  } catch (e) {
    return positionErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.position.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createPositionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const position = await createPosition({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      positionCode: body.positionCode,
      title: body.title,
      departmentId: body.departmentId,
      locationId: body.locationId,
      employerSubsidiaryId: body.employerSubsidiaryId,
      jobGrade: body.jobGrade,
      plannedFte: body.plannedFte,
      status: body.status,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      reason: body.reason,
    });
    return NextResponse.json({ position }, { status: 201 });
  } catch (e) {
    return positionErrorResponse(e);
  }
}
