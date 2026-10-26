import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { fileContentDisposition } from "@/lib/export";
import { readDocumentFile } from "@openbooks/engine/hrm/documents/documents";
import { guardPermission } from "@/lib/authz";
import { hrmDocumentsErrorResponse } from "../../_lib";
/**
 * HR readers use the documents grant; the subject reads their own file
 * through the self grant. The fence lives in the service either way —
 * a self-grant holder asking for someone else's file meets FORBIDDEN.
 */
export const GET = defineRoute({
  authorize: async () => {
    const hr = await guardPermission("hrm.documents.read");
    return hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
  },
  feature: "hrmDocuments",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: actor, params }) => {
    try {
      const { id } = params;
      const file = await readDocumentFile({
        orgId: actor.user.orgId,
        actorId: actor.user.id,
        documentId: id,
      });
      return new NextResponse(file.bytes as unknown as BodyInit, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": fileContentDisposition("attachment", file.filename),
        },
      });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
