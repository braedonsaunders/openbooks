import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  createClassification,
  listClassifications,
} from "@openbooks/engine/src/hrm/construction/classifications.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { constructionErrorResponse } from "../_lib";
import { createClassificationBody } from "../bodies";

export const runtime = "nodejs";

/** Work classifications: the org's trade taxonomy (Setup registry mirrors this). */
export async function GET() {
  const gate = await guardPermission("hrm.construction.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const classifications = await listClassifications(db, gate.user.orgId, gate.user.id);
    return NextResponse.json({ classifications });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission("hrm.construction.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmConstructionCompliance"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, createClassificationBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const classification = await createClassification(db, {
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ...parsedBody.data,
    });
    return NextResponse.json({ classification }, { status: 201 });
  } catch (e) {
    return constructionErrorResponse(e);
  }
}

