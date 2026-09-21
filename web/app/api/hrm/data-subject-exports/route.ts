import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { listExports, requestExport } from "@openbooks/engine/src/hrm/documents/dsar.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { requestExportBody } from "../retention-schedules/bodies";

async function gateExports(orgId: string): Promise<NextResponse | null> {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isFeatureEnabled(orgId, "hrmDocuments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(orgId, "hrmDataSubjectExport"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

export async function GET(req: Request) {
  const gate = await guardPermission("hrm.documents.read");
  if (gate instanceof NextResponse) return gate;
  const off = await gateExports(gate.user.orgId);
  if (off) return off;
  try {
    const params = new URL(req.url).searchParams;
    const exports = await listExports({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      partyId: params.get("partyId") ?? undefined,
    });
    return NextResponse.json({ exports });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}

/**
 * Request a subject-access export. The requester needs documents.manage
 * or must BE the subject (fenced in the service). The zip builds in the
 * worker; the row starts queued.
 */
export async function POST(req: Request) {
  // The service fences subject-vs-manage itself, so the route admits
  // both HR readers and self-service logins; anyone else meets 403 here.
  const hr = await guardPermission("hrm.documents.manage");
  const actor = hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
  if (actor instanceof NextResponse) return actor;
  const off = await gateExports(actor.user.orgId);
  if (off) return off;
  const parsedBody = await parseJsonBody(req, requestExportBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const exportRequest = await requestExport({
      orgId: actor.user.orgId,
      actorId: actor.user.id,
      partyId: parsedBody.data.partyId,
    });
    return NextResponse.json({ export: exportRequest }, { status: 201 });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
