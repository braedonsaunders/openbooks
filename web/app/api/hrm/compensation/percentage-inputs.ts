import { z } from "zod";
import { canonicalDecimal, compareDecimal } from "@openbooks/engine/src/money/exact-decimal.ts";

function percentage(field: string) {
  return z.string({ error: `${field} must be sent as a decimal string` }).transform((raw, ctx) => {
    const exact = canonicalDecimal(raw, 6);
    if (exact === null || compareDecimal(exact, "0") < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must be non-negative with at most 6 decimals — send the exact decimal text`,
      });
      return z.NEVER;
    }
    return exact;
  });
}

/** Registry for every exact percentage input at the HRM compensation API boundary. */
export const COMPENSATION_PERCENTAGE_INPUTS = {
  proposedPct: percentage("Proposed percent"),
  gapThresholdPct: percentage("Gap threshold percent"),
} as const;
