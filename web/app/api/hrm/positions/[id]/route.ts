import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import {
  closePosition,
  revisePosition,
  writePositionFunding,
} from "@openbooks/engine/src/hrm/positions.ts";
import { getPositionAsOf } from "@openbooks/engine/src/hrm/positions-read.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { positionErrorResponse } from "../../compensation/_lib";
import { patchPositionBody } from "../../compensation/bodies";

export const runtime = "nodejs";

/**
 * One position: GET resolves the applicable version with funding by period,
 * holders, and vacancy (position read gate in the service); PATCH revises,
 * closes, or funds through an action-discriminated body (position manage
 * gate in the service). The client checks res.ok before parsing: whole-call
 * denials are HTTP errors with `{ error }` bodies.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.position.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid position" }, { status: 400 });
  const { searchParams } = new URL(req.url);
  const rawDate = searchParams.get("effectiveDate");
  const effectiveDate = rawDate ?? (await businessToday(gate.user.orgId));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    return NextResponse.json({ error: "effectiveDate must be YYYY-MM-DD" }, { status: 400 });
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
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.position.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid position" }, { status: 400 });
  const parsedBody = await parseJsonBody(req, patchPositionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
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
      return NextResponse.json({ funding: result.funding, preflight: result.preflight });
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
}
