import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  listExports,
  requestExport,
} from "@openbooks/engine/src/hrm/documents/dsar.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { requestExportBody } from "../retention-schedules/bodies";

/** Subject-access exports are part of HR documents (which requires HRM). */
export async function gateExports(orgId: string): Promise<NextResponse | null> {
  if (!(await isFeatureEnabled(orgId, "hrmDocuments"))) return notFound("record");
  return null;
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
  public: "session",
  body: requestExportBody,
  handler: async ({ body: body }) => {
    // The service fences subject-vs-manage itself, so the route admits
    // both HR readers and self-service logins; anyone else meets 403 here.
    const hr = await guardPermission("hrm.documents.manage");
    const actor =
      hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
    if (actor instanceof NextResponse) return actor;
    const off = await gateExports(actor.user.orgId);
    if (off) return off;

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
