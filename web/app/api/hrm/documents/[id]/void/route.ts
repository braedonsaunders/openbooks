import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { voidDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { voidDocumentBody } from "../../bodies";
export const POST = defineRoute({
  permission: "hrm.documents.manage",
  feature: "hrmDocuments",
  body: voidDocumentBody,
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params, body }) => {
    try {
      const { id } = params;
      const document = await voidDocument({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        documentId: id,
        reason: body.reason,
      });
      return NextResponse.json({ document });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
