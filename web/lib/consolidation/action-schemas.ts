import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { exactMoney } from "../api/json-schema";

const UUID = z.string().regex(UUID_RE);
const IDEMPOTENCY_KEY = z.string().min(1).max(120);
const RATE = z.string().max(40);
const EXACT_MONEY_TEXT = z.string().regex(/^-?\d+(?:\.\d{1,4})?$/);
const CALENDAR_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isIsoCalendarDate, "enter a calendar date");

export const netInvestmentAssessmentSchema = z
  .object({
    pairId: UUID.describe("Intercompany pair id for the investment."),
    bookId: UUID.describe("Accounting book for the assessment."),
    eliminationSubsidiaryId: UUID.describe("Subsidiary that owns the elimination entry."),
    ociAccountId: UUID.describe("Other comprehensive income account."),
    profitLossAccountId: UUID.describe("Profit and loss account."),
    sourceLineIds: z
      .array(UUID)
      .min(1)
      .max(200)
      .describe("Posted journal line ids supporting the assessment."),
    notPlannedOrLikely: z
      .literal(true)
      .describe("Confirm the balance is neither planned nor likely to settle."),
    nonTrade: z.literal(true).describe("Confirm the balance is a non-trade monetary item."),
    qualificationEvidence: z
      .string()
      .trim()
      .min(40)
      .max(10000)
      .describe("Evidence that the net investment qualification is met."),
    effectiveOn: CALENDAR_DATE.describe("Assessment effective date (YYYY-MM-DD)."),
    reason: z.string().trim().min(8).max(1000).describe("Reason for the assessment."),
    idempotencyKey: IDEMPOTENCY_KEY.describe("Unique retry key for this assessment."),
  })
  .strict();

const lossOfControlInputSchema = z.object({
  effectiveOn: CALENDAR_DATE.describe("Date control was lost (YYYY-MM-DD)."),
  reason: z.string().trim().min(8).max(1000).describe("Reason for the loss-of-control assessment."),
  idempotencyKey: IDEMPOTENCY_KEY.describe("Unique retry key for this assessment."),
  assessment: z
    .string()
    .trim()
    .min(8)
    .max(4000)
    .describe("Assessment of the loss-of-control transaction."),
  ociAssessment: z
    .string()
    .trim()
    .min(8)
    .max(4000)
    .describe("Assessment of accumulated OCI treatment."),
  eliminationSubsidiaryId: UUID.describe("Subsidiary that owns the elimination entry."),
  proceeds: EXACT_MONEY_TEXT.describe("Exact proceeds as a decimal string."),
  proceedsAccountId: UUID.describe("Account receiving the proceeds."),
  parentInvestmentCarrying: EXACT_MONEY_TEXT.describe(
    "Exact carrying amount of the parent investment.",
  ),
  parentRetainedCarrying: EXACT_MONEY_TEXT.describe(
    "Exact retained carrying amount before the disposal.",
  ),
  parentToGroupRate: RATE.describe("Exact parent-to-group translation rate."),
  investmentTranslationAccountId: UUID.describe(
    "Translation adjustment account for the investment.",
  ),
  retainedFairValue: EXACT_MONEY_TEXT.describe("Exact fair value of the retained interest."),
  retainedPercent: EXACT_MONEY_TEXT.describe("Exact retained ownership percentage."),
  retainedMethod: z
    .enum(["none", "equity", "financial_asset"])
    .describe("Accounting method for the retained interest."),
  retainedAccountId: UUID.describe("Account for the retained interest."),
  gainLossAccountId: UUID.describe("Gain or loss account for the group disposal."),
  parentGainLossAccountId: UUID.describe("Gain or loss account for the parent ledger."),
  equityIncomeAccountId: UUID.describe("Equity income account."),
  distributionAccountId: UUID.nullable().describe("Distribution account, when applicable."),
  distributionIncomeAccountId: UUID.nullable().describe(
    "Distribution income account, when applicable.",
  ),
  rates: z
    .array(
      z.object({
        subsidiaryId: UUID.describe("Subsidiary id."),
        rate: RATE.describe("Exact translation rate."),
      }),
    )
    .min(1)
    .max(1000)
    .describe("Effective translation rates for subsidiaries in the disposal."),
  additionalConsolidationLines: z
    .array(
      z.object({
        lineId: UUID.describe("Existing consolidation line id."),
        amount: EXACT_MONEY_TEXT.describe("Exact adjustment amount as a decimal string."),
      }),
    )
    .max(2000)
    .describe("Additional consolidation line adjustments."),
  oci: z
    .array(
      z.object({
        accountId: UUID.describe("OCI source account."),
        balance: EXACT_MONEY_TEXT.describe("Exact accumulated balance as a decimal string."),
        treatment: z.enum(["profit_loss", "retained_earnings"]).describe("Destination treatment."),
        destinationAccountId: UUID.describe("Destination account for the OCI balance."),
        description: z.string().trim().min(1).max(1000).describe("Explanation of this OCI item."),
      }),
    )
    .max(100)
    .describe("Accumulated OCI balances and their approved treatments."),
});

export const lossOfControlToolSchema = lossOfControlInputSchema;
export const lossOfControlSchema = lossOfControlInputSchema.transform((input) => {
  const normalize = (value: string) => exactMoney().parse(value);
  return {
    ...input,
    proceeds: normalize(input.proceeds),
    parentInvestmentCarrying: normalize(input.parentInvestmentCarrying),
    parentRetainedCarrying: normalize(input.parentRetainedCarrying),
    retainedFairValue: normalize(input.retainedFairValue),
    retainedPercent: normalize(input.retainedPercent),
    additionalConsolidationLines: input.additionalConsolidationLines.map((line) => ({
      ...line,
      amount: normalize(line.amount),
    })),
    oci: input.oci.map((item) => ({ ...item, balance: normalize(item.balance) })),
  };
});

export const netInvestmentReversalSchema = z
  .object({
    effectiveOn: CALENDAR_DATE.describe("Correction effective date (YYYY-MM-DD)."),
    reason: z.string().trim().min(8).max(1000).describe("Reason for correcting the assessment."),
    idempotencyKey: IDEMPOTENCY_KEY.describe("Unique retry key for this correction."),
  })
  .strict();

export const lossOfControlReversalSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(8)
      .max(1000)
      .describe("Reason for reversing this consolidation change."),
    idempotencyKey: IDEMPOTENCY_KEY.describe("Unique retry key for this reversal."),
  })
  .strict();
