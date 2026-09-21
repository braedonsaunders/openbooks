import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  createJobFamily,
  listJobFamilies,
} from "@openbooks/engine/src/hrm/compensation/architecture.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { compensationErrorResponse } from "../compensation/_lib";
import { createFamilyBody } from "../compensation/bodies";

export const runtime = "nodejs";

/**
 * Job families. GET lists through the compensation read gate; POST
 * authors through the manage gate. Gated on hrmCompensation — with only
 * the parent on, the org gets architecture and bands; cycles, plans and
 * transparency are their own opt-ins. The client checks res.ok before
 * parsing.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  try {
    const families = await listJobFamilies({ orgId: gate.user.orgId, actorId: gate.user.id, includeInactive });
    return NextResponse.json({ families });
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
  const parsedBody = await parseJsonBody(req, createFamilyBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const family = await createJobFamily({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      code: body.code,
      name: body.name,
      description: body.description ?? null,
    });
    return NextResponse.json({ family }, { status: 201 });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
