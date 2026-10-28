import { z } from "zod";
import { uuidId } from "./json";

/** Typed request contracts for register transactions. Amounts stay decimal strings. */
const decimalText = z
  .string()
  .trim()
  .max(24)
  .describe("Exact decimal text; JSON numbers are refused.");

export const posDiscountSchema = z
  .object({
    kind: z.enum(["percent", "amount"]).describe("Discount representation."),
    value: decimalText.describe("Discount amount or percent as exact decimal text."),
  })
  .strict();

export const posSaleLineSchema = z
  .object({
    itemId: uuidId.describe("Item UUID from the POS item search."),
    quantity: decimalText.describe("Quantity to sell as exact decimal text."),
    unitPrice: decimalText.nullable().optional().describe("Optional exact unit-price override."),
    discount: posDiscountSchema.nullable().optional().describe("Optional line discount."),
  })
  .strict();

export const posPaymentSchema = z
  .object({
    kind: z
      .enum(["cash", "card", "stored_value", "other"])
      .describe("Configured payment tender kind."),
    amount: decimalText.nullable().optional().describe("Exact payment amount."),
    tendered: decimalText.nullable().optional().describe("Cash tendered, when applicable."),
    reference: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .describe("External payment reference."),
    code: z.string().trim().max(64).nullable().optional().describe("Configured tender code."),
    label: z
      .string()
      .trim()
      .max(60)
      .nullable()
      .optional()
      .describe("Operator-facing tender label."),
  })
  .strict();

export const posQuoteBody = z
  .object({
    registerId: uuidId.describe("POS register UUID from list_pos_registers."),
    customerId: uuidId.nullable().optional().describe("Optional customer party UUID."),
    lines: z.array(posSaleLineSchema).min(1).max(200).describe("Cart lines to price."),
    orderDiscount: posDiscountSchema
      .nullable()
      .optional()
      .describe("Optional order-level discount."),
  })
  .strict();

export const posSaleBody = z
  .object({
    sessionId: uuidId.describe("Open POS session UUID from list_pos_sessions."),
    customerId: uuidId.nullable().optional().describe("Optional customer party UUID."),
    lines: z.array(posSaleLineSchema).min(1).max(200).describe("Items and quantities sold."),
    orderDiscount: posDiscountSchema
      .nullable()
      .optional()
      .describe("Optional order-level discount."),
    payments: z
      .array(posPaymentSchema)
      .max(10)
      .describe("Tender allocations; may be empty only for a zero-total sale."),
    expectedTotal: decimalText
      .nullable()
      .optional()
      .describe("Optional total confirmed by the cashier, as exact decimal text."),
  })
  .strict();

export const posRefundBody = z
  .object({
    sessionId: uuidId.describe("Open POS session UUID from list_pos_sessions."),
    originalDocumentId: uuidId.describe("Posted receipt UUID from the POS receipt read."),
    lines: z
      .array(
        z
          .object({
            lineNumber: z
              .number()
              .int()
              .min(1)
              .max(100000)
              .describe("Original receipt line number."),
            quantity: decimalText.describe("Quantity to refund as exact decimal text."),
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .describe("Original receipt lines to refund."),
    payments: z.array(posPaymentSchema).max(10).describe("Refund tender allocations."),
    reason: z.string().trim().max(500).nullable().optional().describe("Reason for the refund."),
  })
  .strict();

export const posCountSchema = z
  .array(
    z
      .object({
        value: decimalText.describe("Cash denomination as exact decimal text."),
        count: z.number().int().min(0).max(1_000_000).describe("Number of pieces counted."),
      })
      .strict(),
  )
  .max(40)
  .describe("Denomination counts entered by the cashier.");
