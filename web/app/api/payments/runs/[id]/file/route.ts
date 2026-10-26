import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  latestApprovedPaymentFile,
  paymentFileStatus,
} from "@openbooks/engine/payments/payment-queries";
import {
  generatePaymentFileArtifact,
  recordPaymentFileDownload,
} from "@openbooks/engine/payments/operations";
import { assertRunPayeesInScope } from "@openbooks/engine/payments/run-readiness";
import { fileContentDisposition } from "@/lib/export";
import { refuseMaskedStorageKind } from "@/lib/file-storage";
import { isUuid } from "@/lib/list-params";
import type { Authz } from "@/lib/authz";
import { guardPaymentRunPermission, paymentErrorResponse } from "../../../lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Download the latest approved immutable file artifact. Generation is a
 * separate POST so profiles that require file approval cannot leak bytes.
 */
async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  try {
    // Serving stored bytes re-discloses current bank coordinates: refuse a
    // caller outside any current payee's scope exactly like generation.
    await assertRunPayeesInScope(gate.user.orgId, id, gate.allowedSubsidiaryIds);
    const file = await latestApprovedPaymentFile(gate.user.orgId, id);
    if (!file)
      return NextResponse.json({ error: "no approved payment file is available" }, { status: 409 });
    // Masked-clone tombstone: the artifact row exists but its bytes were
    // never copied — refuse by name (403 via paymentErrorResponse), never as
    // a misleading 409 'no approved file'.
    refuseMaskedStorageKind(file.storage_kind);
    if (!file.bytes)
      return NextResponse.json({ error: "no approved payment file is available" }, { status: 409 });
    await recordPaymentFileDownload(file.id, gate.user.orgId, gate.user.id);
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.content_type,
        "Content-Disposition": fileContentDisposition("attachment", file.filename),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return paymentErrorResponse(e);
  }
}

/** Generate and persist a new file artifact for an approved run. */
async function legacyPOST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  try {
    const file = await generatePaymentFileArtifact(id, gate.user.orgId, gate.user.id, {
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    const status = await paymentFileStatus(gate.user.orgId, file.id);
    return NextResponse.json({ id: file.id, filename: file.filename, status });
  } catch (e) {
    return paymentErrorResponse(e);
  }
}

export const GET = defineRoute({
  authorize: async ({ params }) => {
    const runId = String((params as { id?: string } | undefined)?.id ?? "");
    return guardPaymentRunPermission(runId);
  },
  feature: {
    none: "Payment-run authorization checks the run direction, capability, and subsidiary scope.",
  },
  handler: async ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params as never) }, authz),
});
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
