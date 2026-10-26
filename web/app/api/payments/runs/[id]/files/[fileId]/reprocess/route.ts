import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { generatePaymentFileArtifact } from "@openbooks/engine/payments/operations";
import { isUuid } from "@/lib/list-params";
import type { Authz } from "@/lib/authz";
import { guardPaymentRunPermission, paymentErrorResponse } from "@/app/api/payments/lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";
async function legacyPOST(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
  gate: Authz,
) {
  const { id, fileId } = await params;
  if (!isUuid(id) || !isUuid(fileId)) return notFound("record");
  try {
    const file = await generatePaymentFileArtifact(id, gate.user.orgId, gate.user.id, {
      reprocessFileId: fileId,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ id: file.id, filename: file.filename });
  } catch (e) {
    return paymentErrorResponse(e);
  }
}

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const runId = String((params as { id?: string } | undefined)?.id ?? "");
    return guardPaymentRunPermission(runId);
  },
  feature: {
    none: "Payment-run authorization checks the run direction, capability, and subsidiary scope.",
  },
  handler: async ({ request, params, authz }) =>
    legacyPOST(request, { params: Promise.resolve(params as never) }, authz),
});
