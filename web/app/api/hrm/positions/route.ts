import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { createPosition } from "@openbooks/engine/src/hrm/positions.ts";
import { getVacancyAsOf } from "@openbooks/engine/src/hrm/positions-read.ts";
import { isCivilDate } from "@openbooks/engine/src/hrm/temporal.ts";
import { positionErrorResponse } from "./_lib";
import { createPositionBody } from "./bodies";
/**
 * Positions collection. GET reads the vacancy as of a date (position read
 * gate in the service, optional status segment); POST opens a position
 * (position manage gate in the service). Employment-to-position assignment
 * rides the change-request routes, never a new endpoint.
 */
export const GET = defineRoute({
  permission: "hrm.position.read",
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const rawDate = url.searchParams.get("effectiveDate");
    const effectiveDate = rawDate ?? (await businessToday(gate.user.orgId));
    if (!isCivilDate(effectiveDate)) {
      return NextResponse.json(
        { error: "effectiveDate must be a real YYYY-MM-DD calendar date" },
        { status: 400 },
      );
    }
    if (
      status !== null &&
      !["planned", "open", "filled", "frozen", "closed"].includes(status)
    ) {
      return NextResponse.json(
        { error: "unknown position status" },
        { status: 400 },
      );
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
  },
});
export const POST = defineRoute({
  permission: "hrm.position.manage",
  feature: "hrm",
  body: createPositionBody,
  handler: async ({ request: _req, authz: gate, body }) => {
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
  },
});
