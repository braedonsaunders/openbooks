import { apiErrorResponse } from "@/lib/api/error-response";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { paymentRunSftpServers } from "@openbooks/engine/payments/payment-queries";
import { deliverRunToSftp } from "@openbooks/engine/sftp/import-job";
import { PaymentError } from "@openbooks/engine/payments-core/payment-errors";
import { isUuid } from "@/lib/list-params";
import { unexpectedServerError } from "@/lib/api/unexpected";
import { uuidId } from "@/lib/api/json";
import type { Authz } from "@/lib/authz";
import { guardPaymentRunPermission } from "../../../lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const deliverBody = z.object({
  sftpServerId: z
    .string({ error: "sftpServerId is required" })
    .refine((v) => uuidId.safeParse(v).success, "sftpServerId is required"),
});

/** Active SFTP servers the run can be delivered to (picker for the run drawer). */
async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const r = await paymentRunSftpServers(gate.user.orgId, id);
  return NextResponse.json({ servers: r });
}

/** Deliver a payment run's bank file to an SFTP server's outbound folder: { sftpServerId }. */
async function legacyPOST(
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
  body: z.infer<typeof deliverBody>,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const { user } = gate;
  try {
    const res = await deliverRunToSftp(id, body.sftpServerId, user.orgId, user.id, new Date());
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof PaymentError) return apiErrorResponse(e, { safeStatus: 422 });
    return unexpectedServerError("payments/deliver", e);
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
  body: deliverBody,
  handler: async ({ params, authz, body }) =>
    legacyPOST({ params: Promise.resolve(params as never) }, authz, body),
});
