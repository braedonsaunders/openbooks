import { NextResponse } from "next/server";
import { listRetentionActions } from "@openbooks/engine/src/hrm/documents/retention.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.documents.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmDocuments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmDocumentRetention"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const pendingOnly = new URL(req.url).searchParams.get("pending") === "1";
    const actions = await listRetentionActions({ orgId: gate.user.orgId, actorId: gate.user.id, pendingOnly });
    return NextResponse.json({ actions });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
