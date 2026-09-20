import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { assignClassification } from "@openbooks/engine/src/hrm/construction/classifications.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { constructionErrorResponse } from "../_lib";
import { assignClassificationBody } from "../bodies";

export const runtime = "nodejs";

/** Employment classifications: bitemporal assignment with history. */
export async function POST(req: Request) {
  const gate = await guardPermission("hrm.construction.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, assignClassificationBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const assignment = await assignClassification(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ assignment }, { status: 201 });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}
