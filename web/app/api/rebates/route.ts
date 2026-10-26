import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";
import { normalizeMoney, wholeDigits } from "@openbooks/engine/money/money";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import {
  cancelRebateClaim,
  approveRebateAgreement,
  generateRebateClaim,
  approveRebateClaim,
  settleRebatePayment,
  reverseRebatePayment,
  attestRebateCost,
} from "@openbooks/engine/revenue/rebates";
import { createRebateSettlement } from "@openbooks/engine/composition/rebate-settlement";
const reason = z.string().trim().min(8).max(2000);
const date = z.string().refine(isIsoCalendarDate, "Enter a calendar date");
function decimal(label: string, scale = 4) {
  return z.string().transform((raw, ctx) => {
    const value = canonicalDecimal(raw, scale);
    if (value === null) {
      ctx.addIssue({ code: "custom", message: moneyRefusal(label, raw, "an amount", scale) });
      return z.NEVER;
    }
    if (wholeDigits(value) > (scale === 10 ? 9 : 15)) {
      ctx.addIssue({ code: "custom", message: `${label} exceeds the supported decimal range` });
      return z.NEVER;
    }
    try {
      return scale === 4 ? normalizeMoney(value) : value;
    } catch {
      ctx.addIssue({ code: "custom", message: moneyRefusal(label, raw, "an amount", scale) });
      return z.NEVER;
    }
  });
}
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approveAgreement"), agreementId: uuidString(), reason }).strict(),
  z
    .object({
      action: z.literal("claim"),
      agreementId: uuidString(),
      partyId: uuidString(),
      cutoffOn: date,
      reason,
    })
    .strict(),
  z.object({ action: z.literal("cancelClaim"), claimId: uuidString(), reason }).strict(),
  z.object({ action: z.literal("approveClaim"), claimId: uuidString(), reason }).strict(),
  z
    .object({ action: z.literal("prepareCredit"), claimId: uuidString(), documentDate: date })
    .strict(),
  z
    .object({
      action: z.literal("pay"),
      claimId: uuidString(),
      postingDate: date,
      bankAccountId: uuidString(),
      fxRate: decimal("Settlement FX rate", 10),
      reason,
    })
    .strict(),
  z
    .object({
      action: z.literal("reversePayment"),
      claimId: uuidString(),
      postingDate: date,
      reason,
    })
    .strict(),
  z
    .object({
      action: z.literal("attestCost"),
      documentLineId: uuidString(),
      costAmount: decimal("Cost amount"),
      resaleAmount: decimal("Downstream resale amount").nullable().optional(),
      currency: z.string().length(3),
      evidence: z.string().trim().min(20).max(4000),
    })
    .strict(),
  z
    .object({ action: z.literal("reassess"), documentId: uuidString(), postingDate: date, reason })
    .strict(),
]);
export const POST = defineRoute({
  permission: "documents.read",
  feature: "rebateManagement",
  body,
  handler: async ({ authz, body }) => {
    try {
      const orgId = authz.user.orgId,
        actorId = authz.user.id;
      switch (body.action) {
        case "approveAgreement":
          return NextResponse.json(
            await approveRebateAgreement(orgId, actorId, body.agreementId, body.reason),
          );
        case "claim":
          return NextResponse.json(
            await generateRebateClaim(
              orgId,
              actorId,
              body.agreementId,
              body.partyId,
              body.cutoffOn,
              body.reason,
            ),
          );
        case "cancelClaim":
          return NextResponse.json(
            await cancelRebateClaim(orgId, actorId, body.claimId, body.reason),
          );
        case "approveClaim":
          return NextResponse.json(
            await approveRebateClaim(orgId, actorId, body.claimId, body.reason),
          );
        case "prepareCredit":
          return NextResponse.json(
            await createRebateSettlement(orgId, actorId, body.claimId, body.documentDate),
          );
        case "pay":
          return NextResponse.json(
            await settleRebatePayment(orgId, actorId, body.claimId, {
              postingDate: body.postingDate,
              bankAccountId: body.bankAccountId,
              fxRate: body.fxRate,
              reason: body.reason,
            }),
          );
        case "reversePayment":
          return NextResponse.json(
            await reverseRebatePayment(orgId, actorId, body.claimId, body.postingDate, body.reason),
          );
        case "attestCost":
          return NextResponse.json(
            await attestRebateCost(orgId, actorId, body.documentLineId, body),
          );
        case "reassess":
          return NextResponse.json(
            await reassessRebates(orgId, actorId, body.documentId, body.postingDate, body.reason),
          );
      }
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
import { reassessRebates } from "@openbooks/engine/revenue/rebates";
