import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { listExports, requestExport } from "@openbooks/engine/hrm/documents/dsar";
import { guardPermission } from "@/lib/authz";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { requestExportBody } from "../retention-schedules/bodies";

export async function authorizeExportAccess() {
  const hr = await guardPermission("hrm.documents.manage");
  return hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
}

export const GET = defineRoute({
  permission: "hrm.documents.read",
  feature: "hrmDocuments",
  handler: async ({ request: req, authz: gate }) => {
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
  },
});

/**
 * Request a subject-access export. The requester needs documents.manage
 * or must BE the subject (fenced in the service). The zip builds in the
 * worker; the row starts queued.
 */
export const POST = defineRoute({
  authorize: authorizeExportAccess,
  feature: "hrmDocuments",
  body: requestExportBody,
  handler: async ({ authz: actor, body }) => {
    try {
      const exportRequest = await requestExport({
        orgId: actor.user.orgId,
        actorId: actor.user.id,
        partyId: body.partyId,
      });
      return NextResponse.json({ export: exportRequest }, { status: 201 });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
