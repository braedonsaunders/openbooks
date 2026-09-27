import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { listRetentionActions } from "@openbooks/engine/src/hrm/documents/retention.ts";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
export const GET = defineRoute({
  permission: "hrm.documents.read",
  feature: "hrmDocumentRetention",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const pendingOnly = new URL(req.url).searchParams.get("pending") === "1";
      const actions = await listRetentionActions({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        pendingOnly,
      });
      return NextResponse.json({ actions });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
