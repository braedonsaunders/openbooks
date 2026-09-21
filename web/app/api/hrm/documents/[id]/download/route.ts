import { NextResponse } from "next/server";
import { readDocumentFile } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { gateDocuments } from "../../route";

/**
 * HR readers use the documents grant; the subject reads their own file
 * through the self grant. The fence lives in the service either way —
 * a self-grant holder asking for someone else's file meets FORBIDDEN.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const hr = await guardPermission("hrm.documents.read");
  const actor = hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
  if (actor instanceof NextResponse) return actor;
  const off = await gateDocuments(actor.user.orgId);
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const file = await readDocumentFile({ orgId: actor.user.orgId, actorId: actor.user.id, documentId: id });
    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${file.filename}"`,
      },
    });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
