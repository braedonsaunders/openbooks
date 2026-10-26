import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { paymentInstructionInRun } from "@openbooks/engine/payments/payment-queries";
import { recordPaymentSettlement } from "@openbooks/engine/payments/operations";
import { isoDate } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
import type { Authz } from "@/lib/authz";
import { guardPaymentRunPermission, paymentErrorResponse } from "@/app/api/payments/lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const settlementBody = z
  .object({
    status: z.enum(["settled", "returned", "rejected"], { error: "A valid outcome is required" }),
    effectiveOn: isoDate("A valid effective date is required"),
    bankReference: z.string().nullable().optional(),
    returnCode: z.string().nullable().optional(),
    returnReason: z.string().nullable().optional(),
  })
  .refine((body) => body.status === "settled" || !!body.returnReason?.trim(), {
    error: "A return reason is required",
  });

async function legacyPOST(
  { params }: { params: Promise<{ id: string; instructionId: string }> },
  gate: Authz,
  body: z.infer<typeof settlementBody>,
) {
  const { id, instructionId } = await params;
  if (!isUuid(id) || !isUuid(instructionId)) return notFound("record");
  const owned = await paymentInstructionInRun(gate.user.orgId, id, instructionId);
  if (!owned) return NextResponse.json({ error: "Payment instruction not found" }, { status: 404 });
  try {
    await recordPaymentSettlement({
      instructionId,
      orgId: gate.user.orgId,
      userId: gate.user.id,
      status: body.status,
      effectiveOn: body.effectiveOn,
      bankReference: body.bankReference ?? null,
      returnCode: body.returnCode ?? null,
      returnReason: body.returnReason ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return paymentErrorResponse(error);
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
  body: settlementBody,
  handler: async ({ params, authz, body }) =>
    legacyPOST({ params: Promise.resolve(params as never) }, authz, body),
});
