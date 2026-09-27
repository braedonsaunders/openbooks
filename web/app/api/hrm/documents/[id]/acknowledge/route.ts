import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { acknowledgeDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../_lib";
/**
 * POST /api/hrm/documents/[id]/acknowledge — acknowledge in-session:
 * the actor's own acknowledgment_only document. Admits self-service
 * logins and HR readers alike; the service fences owner-vs-manage
 * itself and refuses anything but an unacknowledged document.
 */
export const POST = defineRoute({
  public: "session",
  feature: "hrmDocuments",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, params }) => {
    const self = await guardPermission("hrm.self.read");
    const actor =
      self instanceof NextResponse
        ? await guardPermission("hrm.documents.read")
        : self;
    if (actor instanceof NextResponse) return actor;
    try {
      const { id } = params;
      const document = await acknowledgeDocument({
        orgId: actor.user.orgId,
        actorId: actor.user.id,
        documentId: id,
      });
      return NextResponse.json({ document });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
