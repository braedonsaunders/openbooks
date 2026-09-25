import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { remindDocument } from "@openbooks/engine/src/hrm/documents/documents.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { applicationContextFromSession } from "../../../../../../lib/application/context";
import { executeIdempotent } from "../../../../../../lib/application/idempotency";
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
    const idempotencyKey = req.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      return NextResponse.json({ error: "a valid idempotency-key header is required" }, { status: 400 });
    }
    let deliveries: Awaited<ReturnType<typeof remindDocument>>["deliveries"] = [];
    const outcome = await executeIdempotent({
      context: applicationContextFromSession(gate, "api", req.headers.get("x-request-id") || randomUUID()),
      operation: "hrm_document.remind",
      idempotencyKey,
      request: { documentId: id },
      successStatus: () => 200,
      execute: async () => {
        const result = await remindDocument({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          documentId: id,
        });
        deliveries = result.deliveries;
        // Signing tokens are returned to the winning request only; the
        // idempotency table stores safe document metadata and never token values.
        return { document: result.document };
      },
    });
    const { document } = outcome.value;
    if (outcome.replayed) return NextResponse.json({ document, deliveries: [] });
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
