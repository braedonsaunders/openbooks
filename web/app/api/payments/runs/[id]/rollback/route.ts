import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { rollbackPaymentRun } from "@openbooks/engine/payments/operations";
import { isUuid } from "@/lib/list-params";
import type { Authz } from "@/lib/authz";
import { guardPaymentRunPermission, paymentErrorResponse } from "@/app/api/payments/lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const rollbackBody = z.object({
  reason: z.string().default(""),
  /** The run number typed back to attest the bank did not process a delivered file. */
  bankNotProcessedAttestation: z.string().optional(),
});

async function legacyPOST(
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
  body: z.infer<typeof rollbackBody>,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  try {
    await rollbackPaymentRun(id, gate.user.orgId, gate.user.id, body.reason, {
      bankNotProcessedAttestation: body.bankNotProcessedAttestation ?? null,
    });
    return NextResponse.json({ ok: true });
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
  body: rollbackBody,
  opaque: {
    reason: "Rollback uses an optional operator reason with a default empty value.",
    bankNotProcessedAttestation:
      "The bank attestation is optional for runs that were not delivered.",
  },
  handler: async ({ params, authz, body }) =>
    legacyPOST({ params: Promise.resolve(params as never) }, authz, body),
});
