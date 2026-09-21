import { NextResponse } from "next/server";
import { remindDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { deliverSignatureInvitations } from "../../../../../../lib/hrm/document-delivery";
import { hrmDocumentsErrorResponse } from "../../_lib";
import { gateDocuments, resolveAppBaseUrl } from "../../route";

/**
 * POST /api/hrm/documents/[id]/remind — re-mint open signers' tokens
 * and re-deliver the fresh links (email when the transport resolves,
 * in-app notification when they hold a login), recording reminded
 * events. Drafts refuse (send them); terminal documents refuse.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("hrm.documents.manage");
  if (gate instanceof NextResponse) return gate;
  const off = await gateDocuments(gate.user.orgId);
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const { document, deliveries } = await remindDocument({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      documentId: id,
    });
    const results = await deliverSignatureInvitations({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      appBaseUrl: resolveAppBaseUrl(req),
      docTitle: document.title,
      recipients: deliveries,
      reminder: true,
    });
    return NextResponse.json({
      document,
      deliveries: deliveries.map((d) => ({
        signerId: d.signerId,
        partyId: d.partyId,
        signUrl: `${resolveAppBaseUrl(req).replace(/\/$/, "")}/sign/${d.token}`,
        notified: results.find((r) => r.partyId === d.partyId)?.notified ?? false,
        emailed: results.find((r) => r.partyId === d.partyId)?.emailed ?? false,
      })),
    });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
