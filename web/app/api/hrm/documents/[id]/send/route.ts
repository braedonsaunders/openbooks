import { NextResponse } from "next/server";
import { sendDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { deliverSignatureInvitations } from "../../../../../../lib/hrm/document-delivery";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { gateDocuments, resolveAppBaseUrl } from "../../route";

/**
 * POST /api/hrm/documents/[id]/send — open ordered signer rows, then
 * deliver each signer their tokened link (email when the mailbox and
 * transport resolve, in-app notification when they hold a login). The
 * links are returned regardless so HR can always hand one over.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.documents.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
  try {
    const { id } = await ctx.params;
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
      expiresDate: document.expiresAt ?? undefined,
      recipients: deliveries,
    });
    return NextResponse.json({
      document,
      deliveries: deliveries.map((d) => ({
        signerId: d.signerId,
        partyId: d.partyId,
        signUrl: `${resolveAppBaseUrl(req).replace(/\/$/, "")}/sign/${d.token}`,
        notified: results.find((r) => r.partyId === d.partyId)?.notified ?? false,
        emailed: results.find((r) => r.partyId === d.partyId)?.emailed ?? false,
        emailSkippedReason: results.find((r) => r.partyId === d.partyId)?.emailSkippedReason ?? null,
      })),
    });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
