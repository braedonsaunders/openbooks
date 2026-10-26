import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import {
  listOutboundPaymentRuns,
  paymentRunBillsInScope,
} from "@openbooks/engine/payments/payment-queries";
import { createPaymentRun as createPaymentRunInEngine } from "@openbooks/engine/payments/run-creation";
import { guardPermission, type Authz } from "@/lib/authz";
import { isoDate, uuidId } from "@/lib/api/json";
import { paymentErrorResponse } from "../lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const createRunBody = z.object({
  paymentBankProfileId: z
    .string({ error: "paymentBankProfileId is required" })
    .refine((v) => uuidId.safeParse(v).success, "paymentBankProfileId is required"),
  billDocumentIds: z
    .array(uuidId, { error: "select at least one bill" })
    .min(1, "select at least one bill"),
  scheduledFor: isoDate().nullable().optional(),
  selectionCriteria: z.record(z.string(), z.json()).optional(),
});

async function listPaymentRuns(gate: Authz) {
  const runs = await listOutboundPaymentRuns(gate.user.orgId, gate.allowedSubsidiaryIds);
  return NextResponse.json({ runs });
}

/** Create a payment run from selected posted, open vendor bills. */
async function createPaymentRun(gate: Authz, body: z.infer<typeof createRunBody>) {
  const user = gate.user;

  // Every selected bill is a record being read into the run: restricted
  // callers may only select bills inside their subsidiary scope. Bills that
  // do not resolve in this org fail closed identically.
  if (gate.allowedSubsidiaryIds) {
    const selected = [...new Set(body.billDocumentIds)];
    if (!(await paymentRunBillsInScope(user.orgId, selected, gate.allowedSubsidiaryIds))) {
      return notFound("record");
    }
  }

  try {
    const run = await createPaymentRunInEngine({
      orgId: user.orgId,
      createdBy: user.id,
      paymentBankProfileId: body.paymentBankProfileId,
      billDocumentIds: body.billDocumentIds,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      scheduledFor: body.scheduledFor ?? null,
      selectionCriteria: body.selectionCriteria ?? {},
    });
    return NextResponse.json(run);
  } catch (e) {
    return paymentErrorResponse(e);
  }
}

const runCollectionFeature = {
  none: "Payment runs are governed by the AP payment permission and their record-specific scope checks.",
} as const;
export const GET = defineRoute({
  authorize: () => guardPermission("ap.pay"),
  feature: runCollectionFeature,
  handler: async ({ authz }) => listPaymentRuns(authz),
});
export const POST = defineRoute({
  authorize: () => guardPermission("ap.pay"),
  feature: runCollectionFeature,
  body: createRunBody,
  handler: async ({ authz, body }) => createPaymentRun(authz, body),
});
