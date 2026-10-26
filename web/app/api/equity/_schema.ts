import { z } from "zod";
import { isoDate, uuidId } from "@/lib/api/json";

/**
 * Request vocabulary shared by the equity routes. Quantities, prices and
 * percentages travel as decimal strings: JSON numbers would cross binary
 * floating point before the engine's exact parsers see them. The engine
 * refuses out-of-scale values by name; these schemas refuse shapes.
 */
export const wholeShares = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "must be a whole number of shares written as text");
export const signedShares = z
  .string()
  .trim()
  .regex(/^-?\d{1,19}$/, "must be a whole number of shares written as text");
export const decimalText = z
  .string()
  .trim()
  .regex(/^\d{1,18}(\.\d{1,10})?$/, "must be a decimal number written as text");
export const signedDecimalText = z
  .string()
  .trim()
  .regex(/^-?\d{1,18}(\.\d{1,10})?$/, "must be a decimal number written as text");
export const optionalDecimal = decimalText.nullable().optional();
export const reason = z.string().trim().min(5).max(2000);
export const idempotencyKey = z.string().trim().min(8).max(200).nullable().optional();
export const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "must be a three-letter currency code");

export const entityQuery = z.object({ subsidiaryId: uuidId, asOf: isoDate() });

/** Parse query parameters against a schema; a malformed query answers 422 with the field issues. */
export function parseQuery<S extends z.ZodType>(
  request: Request,
  schema: S,
): { ok: true; data: z.output<S> } | { ok: false; response: Response } {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    response: Response.json(
      {
        error: "Invalid query parameters.",
        fieldErrors: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join(".") || "query", issue.message]),
        ),
      },
      { status: 422 },
    ),
  };
}

const vesting = {
  vestingStart: isoDate().nullable().optional(),
  vestingMonths: z.number().int().min(1).max(600).nullable().optional(),
  cliffMonths: z.number().int().min(0).max(600).nullable().optional(),
  vestingFrequency: z.enum(["monthly", "quarterly", "annual"]).nullable().optional(),
  vestingTranches: z
    .array(z.object({ date: isoDate(), quantity: wholeShares }))
    .max(600)
    .nullable()
    .optional(),
  acceleration: z.enum(["none", "single", "double"]).optional(),
  accelerationPercent: optionalDecimal,
};

export const issueSecurityBody = z.object({
  subsidiaryId: uuidId,
  kind: z.enum(["share", "option", "rsu", "warrant", "safe", "note"]),
  holderPartyId: uuidId,
  securityNumber: z.string().trim().max(40).nullable().optional(),
  issueDate: isoDate(),
  shareClassId: uuidId.nullable().optional(),
  planId: uuidId.nullable().optional(),
  roundId: uuidId.nullable().optional(),
  quantity: wholeShares.nullable().optional(),
  pricePerShare: optionalDecimal,
  considerationAmount: optionalDecimal,
  considerationAccountId: uuidId.nullable().optional(),
  expirationDate: isoDate().nullable().optional(),
  optionType: z.enum(["iso", "nso"]).nullable().optional(),
  earlyExercise: z.boolean().optional(),
  unvestedRepurchaseBasis: z.enum(["cost", "lower_of_cost_or_fmv"]).nullable().optional(),
  safeType: z.enum(["pre_money", "post_money"]).nullable().optional(),
  mfn: z.boolean().optional(),
  valuationCap: optionalDecimal,
  discountPercent: optionalDecimal,
  interestRatePercent: optionalDecimal,
  interestBasis: z
    .enum([
      "simple",
      "compound_annual",
      "compound_semiannual",
      "compound_quarterly",
      "compound_monthly",
    ])
    .nullable()
    .optional(),
  interestDayCount: z
    .enum(["actual_365", "actual_360", "thirty_360", "actual_actual"])
    .nullable()
    .optional(),
  currency: currencyCode.nullable().optional(),
  maturityDate: isoDate().nullable().optional(),
  valuation: z
    .object({
      sharePrice: decimalText,
      volatilityPercent: optionalDecimal,
      riskFreeRatePercent: signedDecimalText.nullable().optional(),
      expectedTermYears: optionalDecimal,
      dividendYieldPercent: optionalDecimal,
      attribution: z.enum(["straight_line", "graded"]),
    })
    .nullable()
    .optional(),
  memo: z.string().max(2000).nullable().optional(),
  idempotencyKey,
  ...vesting,
});
