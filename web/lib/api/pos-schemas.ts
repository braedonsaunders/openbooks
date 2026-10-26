import { z } from "zod";
import { uuidId } from "./json";

/** Typed request contracts for the register API. Amounts stay decimal strings; the engine parses them exactly. */
const decimalText = z.string().trim().max(24);

export const posDiscountSchema = z
  .object({ kind: z.enum(["percent", "amount"]), value: decimalText })
  .strict();

export const posSaleLineSchema = z
  .object({
    itemId: uuidId,
    quantity: decimalText,
    unitPrice: decimalText.nullable().optional(),
    discount: posDiscountSchema.nullable().optional(),
  })
  .strict();

export const posPaymentSchema = z
  .object({
    kind: z.enum(["cash", "card", "stored_value", "other"]),
    amount: decimalText.nullable().optional(),
    tendered: decimalText.nullable().optional(),
    reference: z.string().trim().max(120).nullable().optional(),
    code: z.string().trim().max(64).nullable().optional(),
    label: z.string().trim().max(60).nullable().optional(),
  })
  .strict();

export const posQuoteBody = z
  .object({
    registerId: uuidId,
    customerId: uuidId.nullable().optional(),
    lines: z.array(posSaleLineSchema).min(1).max(200),
    orderDiscount: posDiscountSchema.nullable().optional(),
  })
  .strict();

export const posSaleBody = z
  .object({
    sessionId: uuidId,
    customerId: uuidId.nullable().optional(),
    lines: z.array(posSaleLineSchema).min(1).max(200),
    orderDiscount: posDiscountSchema.nullable().optional(),
    // Empty only for a sale that totals exactly zero; the engine refuses an
    // empty list whenever anything is due.
    payments: z.array(posPaymentSchema).max(10),
    expectedTotal: decimalText.nullable().optional(),
  })
  .strict();

export const posRefundBody = z
  .object({
    sessionId: uuidId,
    originalDocumentId: uuidId,
    lines: z
      .array(
        z
          .object({ lineNumber: z.number().int().min(1).max(100000), quantity: decimalText })
          .strict(),
      )
      .min(1)
      .max(200),
    // Empty only for a refund that totals exactly zero, as on a sale.
    payments: z.array(posPaymentSchema).max(10),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const posCountSchema = z
  .array(z.object({ value: decimalText, count: z.number().int().min(0).max(1_000_000) }).strict())
  .max(40);
