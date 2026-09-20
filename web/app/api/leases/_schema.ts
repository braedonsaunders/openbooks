import { z } from "zod";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { exactMoney } from "@/lib/api/json";
const date = z
  .string()
  .refine(isIsoCalendarDate, "enter a calendar date (YYYY-MM-DD)");
const rate = z.string().max(25);
export const leaseClassificationSchema = z.object({
  transfersOwnership: z.boolean().optional(),
  purchaseOptionReasonablyCertain: z.boolean().optional(),
  leaseTermMonths: z.number().int().nonnegative().optional(),
  economicLifeMonths: z.number().int().nonnegative().optional(),
  termThresholdPercent: exactMoney().optional(),
  pvOfPayments: exactMoney().optional(),
  fairValue: exactMoney().optional(),
  pvThresholdPercent: exactMoney().optional(),
  specializedAsset: z.boolean().optional(),
});
export const leaseSchema = z.object({
  subsidiaryId: z.uuid(),
  leaseNumber: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  commencementOn: date,
  termPeriods: z.number().int().positive(),
  paymentFrequency: z.enum(["monthly", "quarterly", "annual"]),
  paymentTiming: z.enum(["advance", "arrears"]),
  paymentAmount: exactMoney(),
  annualDiscountRatePercent: rate,
  classificationInputs: leaseClassificationSchema,
  exemption: z.enum(["short_term", "low_value"]).nullable().optional(),
  initialDirectCosts: exactMoney().optional(),
  prepayments: exactMoney().optional(),
  incentives: exactMoney().optional(),
  costClearingAccountId: z.uuid().nullable().optional(),
  openingBalances: z
    .object({ liability: exactMoney(), rouCarrying: exactMoney(), asOf: date })
    .nullable()
    .optional(),
  accounts: z.object({
    rouAsset: z.uuid(),
    leaseLiability: z.uuid(),
    interestExpense: z.uuid(),
    amortizationExpense: z.uuid(),
    leaseExpense: z.uuid(),
    payment: z.uuid(),
  }),
  departmentId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
});
export const leaseChangeSchema = z.object({
  operation: z.enum([
    "modification",
    "remeasurement",
    "termination",
    "separate_lease",
  ]),
  effectiveOn: date,
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().min(1).max(120),
  scopeReductionPercent: exactMoney(),
  settlementPayment: exactMoney(),
  gainLossAccountId: z.uuid(),
  assessment: z.string().trim().min(8).max(4000),
  remainingTerms: z
    .object({
      periods: z.number().int().positive(),
      payment: exactMoney(),
      paymentFrequency: z.enum(["monthly", "quarterly", "annual"]),
      paymentTiming: z.enum(["advance", "arrears"]),
      annualRatePercent: rate,
      classificationInputs: leaseClassificationSchema,
    })
    .optional(),
  separateLease: z
    .object({
      additionalRightOfUse: z.literal(true),
      commensurateStandalonePrice: z.literal(true),
      agreement: leaseSchema,
    })
    .optional(),
});
export const leasePostSchema = z.object({ asOfDate: date });
