import { NextResponse } from "next/server";
import { acknowledgeDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { gateDocuments } from "../../route";

/**
 * POST /api/hrm/documents/[id]/acknowledge — acknowledge in-session:
 * the actor's own acknowledgment_only document. Admits self-service
 * logins and HR readers alike; the service fences owner-vs-manage
 * itself and refuses anything but an unacknowledged document.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const self = await guardPermission("hrm.self.read");
  const actor = self instanceof NextResponse ? await guardPermission("hrm.documents.read") : self;
  if (actor instanceof NextResponse) return actor;
  const off = await gateDocuments(actor.user.orgId);
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const document = await acknowledgeDocument({
      orgId: actor.user.orgId,
      actorId: actor.user.id,
      documentId: id,
    });
    return NextResponse.json({ document });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
