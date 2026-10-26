import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { resolveUncertainDelivery } from "@openbooks/engine/payments/operations";
import { isUuid } from "@/lib/list-params";
import type { Authz } from "@/lib/authz";
import { guardPaymentRunPermission, paymentErrorResponse } from "@/app/api/payments/lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const resolveDeliveryBody = z.object({
  outcome: z.enum(["delivered", "approved"], { error: "outcome must be delivered or approved" }),
  reason: z.string().trim().min(1, "a resolution reason is required"),
});

/**
 * Resolve a delivery_uncertain file: confirm the bank has the bytes
 * (delivered, recording delivery evidence) or release it back to approved
 * for a careful re-delivery (only after verifying with the bank that
 * nothing arrived). Approval-grade permission; the decision and its reason
 * are audited on the file's event trail by the engine.
 */
async function legacyPOST(
  { params }: { params: Promise<{ id: string; fileId: string }> },
  gate: Authz,
  body: z.infer<typeof resolveDeliveryBody>,
) {
  const { id, fileId } = await params;
  if (!isUuid(id) || !isUuid(fileId)) return notFound("record");
  try {
    await resolveUncertainDelivery({
      fileId,
      orgId: gate.user.orgId,
      userId: gate.user.id,
      outcome: body.outcome,
      reason: body.reason,
      runId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return paymentErrorResponse(e);
  }
}

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const runId = String((params as { id?: string } | undefined)?.id ?? "");
    return guardPaymentRunPermission(runId, "approve");
  },
  feature: {
    none: "Payment-run authorization checks the run direction, capability, and subsidiary scope.",
  },
  body: resolveDeliveryBody,
  handler: async ({ params, authz, body }) =>
    legacyPOST({ params: Promise.resolve(params as never) }, authz, body),
});
