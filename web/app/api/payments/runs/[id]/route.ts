import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { loadPaymentRunDetail } from "@openbooks/engine/payments/payment-queries";
import { cancelPaymentRun } from "@openbooks/engine/payments/run-cancellation";
import { isUuid } from "@/lib/list-params";
import type { Authz } from "@/lib/authz";
import { guardPaymentRunPermission, paymentErrorResponse } from "../../lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const cancelBody = z.object({
  reason: z.string().trim().min(1, "a cancellation reason is required"),
});

async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const detail = await loadPaymentRunDetail(gate.user.orgId, id, gate.allowedSubsidiaryIds);
  return detail ? NextResponse.json(detail) : notFound("record");
}

/** Cancel a draft/exported run: deletes its draft payments, keeps the audit row. */
async function legacyDELETE(
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
  body: z.infer<typeof cancelBody>,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  try {
    await cancelPaymentRun(id, gate.user.orgId, gate.user.id, body.reason);
    return NextResponse.json({ ok: true });
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
export const DELETE = defineRoute({
  authorize: async ({ params }) => {
    const runId = String((params as { id?: string } | undefined)?.id ?? "");
    return guardPaymentRunPermission(runId);
  },
  feature: {
    none: "Payment-run authorization checks the run direction, capability, and subsidiary scope.",
  },
  body: cancelBody,
  handler: async ({ params, authz, body }) =>
    legacyDELETE({ params: Promise.resolve(params as never) }, authz, body),
});
