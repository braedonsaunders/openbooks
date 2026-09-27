import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sendDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { deliverSignatureInvitations } from "../../../../../../lib/hrm/document-delivery";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { resolveAppBaseUrl } from "../../route";
/**
 * POST /api/hrm/documents/[id]/send — open ordered signer rows, then
 * deliver each signer their tokened link (email when the mailbox and
 * transport resolve, in-app notification when they hold a login). The
 * links are returned regardless so HR can always hand one over.
 */
export const POST = defineRoute({
  permission: "hrm.documents.manage",
  feature: "hrmDocuments",
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
    try {
      const { id } = params;
      const { document, deliveries } = await sendDocument({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        documentId: id,
      });
      const results = await deliverSignatureInvitations({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        appBaseUrl: resolveAppBaseUrl(req),
        docTitle: document.title,
        expiresDate: document.expiresAt?.toISOString(),
        recipients: deliveries,
      });
      return NextResponse.json({
        document,
        deliveries: deliveries.map((d) => ({
          signerId: d.signerId,
          partyId: d.partyId,
          signUrl: `${resolveAppBaseUrl(req).replace(/\/$/, "")}/sign/${d.token}`,
          notified:
            results.find((r) => r.partyId === d.partyId)?.notified ?? false,
          emailed:
            results.find((r) => r.partyId === d.partyId)?.emailed ?? false,
          emailSkippedReason:
            results.find((r) => r.partyId === d.partyId)?.emailSkippedReason ??
            null,
        })),
      });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
