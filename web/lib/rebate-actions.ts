import "server-only";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { canonicalDecimal } from "./exact-decimal";
import { moneyRefusal } from "./payroll-decimal-refusal";
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
  reassessRebates,
} from "@openbooks/engine/revenue/rebates";
import { createRebateSettlement } from "@openbooks/engine/composition/rebate-settlement";

const reason = z
  .string()
  .trim()
  .min(8)
  .max(2000)
  .describe("Reason recorded in the rebate audit trail.");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isIsoCalendarDate, "Enter a calendar date")
  .describe("Calendar date in YYYY-MM-DD format.");
const uuid = (description: string) => uuidString().describe(description);

function decimal(label: string, scale = 4) {
  return z
    .string()
    .transform((raw, ctx) => {
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
    })
    .describe(`Exact ${label.toLowerCase()} as decimal text.`);
}

export const approveRebateAgreementBody = z
  .object({
    action: z.literal("approveAgreement").describe("Approve a rebate agreement."),
    agreementId: uuid("Rebate agreement UUID."),
    reason,
  })
  .strict();

export const generateRebateClaimBody = z
  .object({
    action: z.literal("claim").describe("Generate a claim from accrued rebates."),
    agreementId: uuid("Approved rebate agreement UUID."),
    partyId: uuid("Customer or vendor party UUID."),
    cutoffOn: date.describe("Last accrual date included in this claim."),
    reason,
  })
  .strict();

export const cancelRebateClaimBody = z
  .object({
    action: z.literal("cancelClaim").describe("Cancel a rebate claim."),
    claimId: uuid("Rebate claim UUID."),
    reason,
  })
  .strict();

export const approveRebateClaimBody = z
  .object({
    action: z.literal("approveClaim").describe("Approve a rebate claim."),
    claimId: uuid("Rebate claim UUID."),
    reason,
  })
  .strict();

export const prepareRebateSettlementBody = z
  .object({
    action: z
      .literal("prepareCredit")
      .describe("Prepare a customer or vendor credit for a rebate claim."),
    claimId: uuid("Approved rebate claim UUID."),
    documentDate: date.describe("Credit document date."),
  })
  .strict();

export const settleRebateClaimBody = z
  .object({
    action: z
      .literal("pay")
      .describe("Settle an outside-scope rebate claim through a bank account."),
    claimId: uuid("Approved rebate claim UUID."),
    postingDate: date.describe("Settlement posting date."),
    bankAccountId: uuid("Bank account UUID."),
    fxRate: decimal("Settlement FX rate", 10),
    reason,
  })
  .strict();

export const reverseRebatePaymentBody = z
  .object({
    action: z.literal("reversePayment").describe("Reverse a posted bank settlement."),
    claimId: uuid("Rebate claim UUID."),
    postingDate: date.describe("Reversal posting date."),
    reason,
  })
  .strict();

export const attestRebateCostBody = z
  .object({
    action: z.literal("attestCost").describe("Record supported rebate cost evidence."),
    documentLineId: uuid("Source document-line UUID."),
    costAmount: decimal("Cost amount"),
    resaleAmount: decimal("Downstream resale amount")
      .nullable()
      .optional()
      .describe("Optional exact resale amount."),
    currency: z.string().length(3).describe("Three-letter document currency."),
    evidence: z
      .string()
      .trim()
      .min(20)
      .max(4000)
      .describe("Supporting cost evidence, at least twenty characters."),
  })
  .strict();

export const reassessRebatesBody = z
  .object({
    action: z.literal("reassess").describe("Reassess accruals for a posted source document."),
    documentId: uuid("Posted sales or purchase document UUID."),
    postingDate: date.describe("Reassessment posting date."),
    reason,
  })
  .strict();

export const rebateBody = z.discriminatedUnion("action", [
  approveRebateAgreementBody,
  generateRebateClaimBody,
  cancelRebateClaimBody,
  approveRebateClaimBody,
  prepareRebateSettlementBody,
  settleRebateClaimBody,
  reverseRebatePaymentBody,
  attestRebateCostBody,
  reassessRebatesBody,
]);

export async function runRebateAction(
  orgId: string,
  actorId: string,
  input: z.infer<typeof rebateBody>,
) {
  switch (input.action) {
    case "approveAgreement":
      return approveRebateAgreement(orgId, actorId, input.agreementId, input.reason);
    case "claim":
      return generateRebateClaim(
        orgId,
        actorId,
        input.agreementId,
        input.partyId,
        input.cutoffOn,
        input.reason,
      );
    case "cancelClaim":
      return cancelRebateClaim(orgId, actorId, input.claimId, input.reason);
    case "approveClaim":
      return approveRebateClaim(orgId, actorId, input.claimId, input.reason);
    case "prepareCredit":
      return createRebateSettlement(orgId, actorId, input.claimId, input.documentDate);
    case "pay":
      return settleRebatePayment(orgId, actorId, input.claimId, {
        postingDate: input.postingDate,
        bankAccountId: input.bankAccountId,
        fxRate: input.fxRate,
        reason: input.reason,
      });
    case "reversePayment":
      return reverseRebatePayment(orgId, actorId, input.claimId, input.postingDate, input.reason);
    case "attestCost":
      return attestRebateCost(orgId, actorId, input.documentLineId, input);
    case "reassess":
      return reassessRebates(orgId, actorId, input.documentId, input.postingDate, input.reason);
  }
}
