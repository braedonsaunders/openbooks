import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getDocumentDetail } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { hrmDocumentsErrorResponse } from "../_lib";
export const GET = defineRoute({
  permission: "hrm.documents.read",
  feature: "hrmDocuments",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    try {
      const { id } = params;
      const document = await getDocumentDetail({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        documentId: id,
      });
      return NextResponse.json({ document });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
