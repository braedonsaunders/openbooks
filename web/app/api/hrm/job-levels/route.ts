import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createJobLevel,
  listJobLevels,
} from "@openbooks/engine/src/hrm/compensation/architecture.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { compensationErrorResponse } from "../compensation/_lib";
import { createLevelBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Job levels. GET lists (optionally per family) through the read gate;
 * POST authors through the manage gate. A level never moves ladders —
 * retire and recreate instead. The client checks res.ok before parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const familyId = url.searchParams.get("familyId");
  if (familyId !== null && familyId !== "" && !isUuid(familyId)) {
    return NextResponse.json({ error: "familyId must be a uuid" }, { status: 400 });
  }
  const includeInactive = url.searchParams.get("includeInactive") === "1";
  try {
    const levels = await listJobLevels({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...(familyId ? { familyId } : {}),
      includeInactive,
    });
    return NextResponse.json({ levels });
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
  const parsedBody = await parseJsonBody(req, createLevelBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const level = await createJobLevel({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      familyId: body.familyId ?? null,
      code: body.code,
      name: body.name,
      rank: body.rank,
      equalValueCriteria: body.equalValueCriteria,
    });
    return NextResponse.json({ level }, { status: 201 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
