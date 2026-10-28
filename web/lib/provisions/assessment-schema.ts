import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { exactMoney, isoDate, uuidId } from "@/lib/api/json";

function createProvisionAssessmentSchema(atoms: {
  uuid: z.ZodType<string>;
  date: z.ZodType<string>;
  money: z.ZodType<string>;
}) {
  const { uuid, date, money } = atoms;
  const estimateSchema = z.discriminatedUnion("method", [
    z
      .object({
        method: z.literal("best_estimate").describe("Single best estimate method."),
        amount: money.describe("Exact decimal estimate amount."),
      })
      .strict(),
    z
      .object({
        method: z.literal("expected_value").describe("Probability-weighted estimate method."),
        outcomes: z
          .array(
            z
              .object({
                amount: money.describe("Exact decimal outcome amount."),
                probability: money.describe("Exact decimal outcome probability."),
              })
              .strict(),
          )
          .min(1)
          .max(1000)
          .describe("Possible outcomes and their probabilities."),
      })
      .strict(),
    z
      .object({
        method: z.literal("uniform_range").describe("Uniform range estimate method."),
        minimum: money.describe("Exact decimal low end of the estimate range."),
        maximum: money.describe("Exact decimal high end of the estimate range."),
      })
      .strict(),
    z
      .object({
        method: z
          .literal("no_better_estimate_range")
          .describe("Range method used when no better estimate is available."),
        minimum: money.describe("Exact decimal low end of the estimate range."),
        maximum: money.describe("Exact decimal high end of the estimate range."),
      })
      .strict(),
  ]);

  return z
    .object({
      obligation: z
        .object({
          id: uuid.describe("Provision obligation id."),
          subsidiaryId: uuid.describe("Legal entity that owns the obligation."),
          bookId: uuid.describe("Accounting book for the assessment."),
          name: z.string().trim().min(1).max(200).describe("Name of the provision obligation."),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .describe("Three-letter currency code."),
          expenseAccountId: uuid.describe("Expense account for the provision."),
          liabilityAccountId: uuid.describe("Liability account for the provision."),
          projectId: uuid.nullable().optional().describe("Project id for a project obligation."),
        })
        .strict()
        .describe("Provision obligation and ledger accounts being assessed."),
      effectiveOn: date.describe("Assessment effective date in YYYY-MM-DD format."),
      reason: z.string().trim().min(8).max(1000).describe("Reason for this assessment."),
      idempotencyKey: z.string().min(1).max(120).describe("Unique retry key for this assessment."),
      construction: z
        .object({
          remainingCost: money.describe("Exact decimal remaining construction cost."),
          terminationAvailable: z.boolean().describe("Whether termination is available."),
          terminationCost: money
            .nullable()
            .describe("Exact decimal termination cost, or null when unavailable."),
          relatedAssetsReviewed: z.boolean().describe("Whether related assets were reviewed."),
          impairmentEvidence: z
            .string()
            .trim()
            .min(20)
            .max(10000)
            .describe("Evidence supporting related-asset impairment review."),
        })
        .strict()
        .optional()
        .describe("Construction loss assessment details for a project obligation."),
      assessment: z
        .object({
          presentObligation: z.boolean().describe("Whether a present obligation exists."),
          outflow: z
            .enum(["probable", "possible", "remote"])
            .describe("Likelihood of an outflow of resources."),
          reliablyEstimable: z.boolean().describe("Whether the amount can be reliably estimated."),
          evidence: z
            .string()
            .trim()
            .min(20)
            .max(10000)
            .describe("Evidence for recognition and measurement."),
          discounting: z
            .enum(["immaterial", "included_in_estimate", "undiscounted"])
            .describe("Discounting treatment for the estimate."),
          discountEvidence: z
            .string()
            .trim()
            .min(20)
            .max(10000)
            .describe("Evidence supporting the discounting treatment."),
          estimate: estimateSchema
            .nullable()
            .describe("Estimate method and exact decimal amounts, or null when not estimable."),
        })
        .strict()
        .describe("Professional assessment evidence and measurement."),
    })
    .strict();
}

/** Native route schema canonicalizes exact decimal input before domain execution. */
export const provisionAssessmentBodySchema = createProvisionAssessmentSchema({
  uuid: uuidId,
  date: isoDate(),
  money: exactMoney(),
});

/** Tool schema stays provider-safe; the native domain service validates amounts and dates. */
export const provisionAssessmentToolSchema = createProvisionAssessmentSchema({
  uuid: z.string().regex(UUID_RE),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  money: z.string().regex(/^-?\d+(?:\.\d{1,4})?$/),
});
