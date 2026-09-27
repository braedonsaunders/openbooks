import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import {
  closePosition,
  revisePosition,
  writePositionFunding,
} from "@openbooks/engine/src/hrm/positions.ts";
import { getPositionAsOf } from "@openbooks/engine/src/hrm/positions-read.ts";
import { isCivilDate } from "@openbooks/engine/src/hrm/temporal.ts";
import { isUuid } from "../../../../../lib/list-params";
import { positionErrorResponse } from "../_lib";
import { patchPositionBody } from "../bodies";
/**
 * One position: GET resolves the applicable version with funding by period,
 * holders, and vacancy (position read gate in the service); PATCH revises,
 * closes, or funds through an action-discriminated body (position manage
 * gate in the service). The client checks res.ok before parsing: whole-call
 * denials are HTTP errors with `{ error }` bodies.
 */
export const GET = defineRoute({
  permission: "hrm.position.read",
  feature: "hrm",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid position" }, { status: 400 });
    const { searchParams } = new URL(req.url);
    const rawDate = searchParams.get("effectiveDate");
    const effectiveDate = rawDate ?? (await businessToday(gate.user.orgId));
    if (!isCivilDate(effectiveDate)) {
      return NextResponse.json(
        { error: "effectiveDate must be a real YYYY-MM-DD calendar date" },
        { status: 400 },
      );
    }
    try {
      const position = await getPositionAsOf({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        positionId: id,
        effectiveDate,
        knownAt: new Date().toISOString(),
      });
      return NextResponse.json({ position });
    } catch (e) {
      return positionErrorResponse(e);
    }
  },
});
export const PATCH = defineRoute({
  permission: "hrm.position.manage",
  feature: "hrm",
  body: patchPositionBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid position" }, { status: 400 });
    try {
      if (body.action === "close") {
        const position = await closePosition({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          positionId: id,
          effectiveDate: body.effectiveDate,
          reason: body.reason,
        });
        return NextResponse.json({ position });
      }
      if (body.action === "fund") {
        const result = await writePositionFunding({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          positionId: id,
          periodId: body.periodId,
          fundedFte: body.fundedFte,
          fundingSourceId: body.fundingSourceId,
          amount: body.amount,
          currency: body.currency,
          reason: body.reason,
        });
        return NextResponse.json({
          funding: result.funding,
          preflight: result.preflight,
        });
      }
      const position = await revisePosition({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        positionId: id,
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
      return NextResponse.json({ position });
    } catch (e) {
      return positionErrorResponse(e);
    }
  },
});
