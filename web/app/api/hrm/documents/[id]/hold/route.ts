import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { setLegalHold } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { holdDocumentBody } from "../../bodies";
export const POST = defineRoute({
  permission: "hrm.documents.manage",
  feature: "hrmDocuments",
  body: holdDocumentBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params, body }) => {
    try {
      const { id } = params;
      const document = await setLegalHold({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        documentId: id,
        hold: body.hold,
      });
      return NextResponse.json({ document });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
