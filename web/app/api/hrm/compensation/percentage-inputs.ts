import { z } from "zod";
import { canonicalDecimal, compareDecimal } from "@openbooks/engine/money/decimal";

function percentage(field: string, description: string) {
  return z
    .string({
      error: (issue) =>
        typeof issue.input === "number" && issue.input < 0
          ? `${field} must be a non-negative ${description}`
          : `${field} must be sent as a decimal string`,
    })
    .transform((raw, ctx) => {
      const exact = canonicalDecimal(raw, 6);
      if (exact === null || compareDecimal(exact, "0") < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be a non-negative ${description} with at most 6 decimals — send the exact decimal text`,
        });
        return z.NEVER;
      }
      return exact;
    });
}

/** Registry for every exact percentage input at the HRM compensation API boundary. */
export const COMPENSATION_PERCENTAGE_INPUTS = {
  proposedPct: percentage("proposedPct", "percent"),
  gapThresholdPct: percentage("gapThresholdPct", "percent"),
} as const;
