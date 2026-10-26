import { z } from "zod";
import { exactMoney, isoDate } from "./api/json-schema";
import { canonicalDecimal, compareDecimal } from "./exact-decimal";

/** All native journal save boundaries accept the same exact instruction fields. */
export const journalRateInput = z
  .string()
  .refine((value) => {
    const decimal = canonicalDecimal(value, 10);
    return (
      decimal !== null && compareDecimal(decimal, "0")! > 0 && decimal.split(".")[0]!.length <= 9
    );
  }, "Enter a positive decimal exchange rate with at most ten decimal places.")
  .transform((value) => canonicalDecimal(value, 10)!);
export const journalHeaderInstructionFields = {
  journalMode: z.enum(["monetary", "statistical", "currency_adjustment"]).optional(),
  journalReverseOn: isoDate().nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  fxRate: journalRateInput.optional(),
};
export const journalLineInstructionFields = {
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  fxRate: journalRateInput.nullable().optional(),
  quantity: exactMoney().optional(),
  unit: z.string().trim().max(64).nullable().optional(),
  eliminate: z.boolean().optional(),
};
