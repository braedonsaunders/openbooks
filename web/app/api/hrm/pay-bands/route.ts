import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createPayBand,
  listPayBands,
} from "@openbooks/engine/src/hrm/compensation/bands.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { compensationErrorResponse } from "../compensation/_lib";
import { createBandBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Pay bands. GET lists live bands (optionally per level) through the
 * read gate; POST opens a new version through the manage gate — a band
 * change is a new row, never an overwrite. The client checks res.ok
 * before parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const levelId = url.searchParams.get("levelId");
  if (levelId !== null && !isUuid(levelId)) {
    return NextResponse.json({ error: "levelId must be a uuid" }, { status: 400 });
  }
  const asOf = url.searchParams.get("asOf");
  if (asOf !== null && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return NextResponse.json({ error: "asOf must be YYYY-MM-DD" }, { status: 400 });
  }
  try {
    const bands = await listPayBands({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...(levelId ? { levelId } : {}),
      ...(asOf ? { asOf } : {}),
    });
    return NextResponse.json({ bands });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createBandBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const band = await createPayBand({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      scope: {
        familyId: body.familyId ?? null,
        levelId: body.levelId,
        employerSubsidiaryId: body.employerSubsidiaryId ?? null,
        locationId: body.locationId ?? null,
      },
      currency: body.currency,
      basis: body.basis,
      min: body.min,
      target: body.target,
      max: body.max,
      effectiveFrom: body.effectiveFrom,
      reason: body.reason,
    });
    return NextResponse.json({ band }, { status: 201 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
