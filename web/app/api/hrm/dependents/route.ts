import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createDependent } from "@openbooks/engine/src/hrm/benefits/dependents.ts";
import { listDependents } from "@openbooks/engine/src/hrm/benefits/benefits-read.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { benefitsErrorResponse } from "../benefits/_lib";
import { createDependentBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Covered dependents: GET lists one employment's, POST creates. Reads need
 * hrm.benefits.read on the employment; writes need manage on it.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.benefits.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const employmentId = url.searchParams.get("employmentId");
  if (!employmentId || !isUuid(employmentId)) {
    return NextResponse.json({ error: "employment id must be a uuid" }, { status: 400 });
  }
  try {
    const dependents = await listDependents(db, gate.user.orgId, gate.user.id, employmentId);
    return NextResponse.json({ dependents });
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
  const parsedBody = await parseJsonBody(req, createDependentBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const dependent = await createDependent({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      employmentId: body.employmentId,
      relationship: body.relationship,
      displayName: body.displayName,
      birthDate: body.birthDate ?? null,
    });
    return NextResponse.json({ dependent });
  } catch (e) {
    return benefitsErrorResponse(e);
  }
}
