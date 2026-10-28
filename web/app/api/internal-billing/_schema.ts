import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const id = uuidString()
  .nullable()
  .optional()
  .describe(
    "UUID for a referenced account, subsidiary, department, project, location, class, or item; null when not applicable.",
  );
const decimal = z
  .string()
  .max(40)
  .nullable()
  .optional()
  .describe("Exact decimal amount or quantity as text; null when not applicable.");

/** The internal billing document contract shared by create and save. */
export const internalBillingBody = z
  .object({
    ruleCode: z.string().min(1).max(120).describe("Rule code from list_internal_billing_rules."),
    documentDate: z
      .string()
      .max(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .describe("Accounting date in YYYY-MM-DD format, or null for today's business date."),
    subsidiaryId: id,
    departmentId: id,
    projectId: id,
    locationId: id,
    classId: id,
    referenceNumber: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe("Optional external or internal reference number."),
    memo: z.string().max(2000).nullable().optional().describe("Optional document memo."),
    lines: z
      .array(
        z
          .object({
            itemId: id,
            description: z.string().max(2000).nullable().optional().describe("Line description."),
            quantity: decimal,
            rate: decimal,
            amount: decimal,
            subsidiaryId: id,
            departmentId: id,
            projectId: id,
            locationId: id,
            classId: id,
            isBillable: z
              .boolean()
              .nullable()
              .optional()
              .describe("Whether this line is billable to a customer."),
            billRate: decimal,
          })
          .strict()
          .describe("A line with its source data, exact amounts, and accounting dimensions."),
      )
      .min(1)
      .max(500)
      .describe(
        "At least one internal billing line, with exact quantities, rates, amounts, and accounting dimensions.",
      ),
  })
  .strict();
