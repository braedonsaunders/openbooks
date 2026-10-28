import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { ACCOUNT_TYPES } from "@openbooks/schema";

// Both create and edit must reject malformed policy values before nullable
// text normalization or PostgreSQL boolean coercion can reinterpret them.
export const accountInputFields = {
  number: z.string().trim().max(80).nullable().optional().describe("Optional account number."),
  type: z.enum(ACCOUNT_TYPES).optional().describe("Chart-of-accounts classification."),
  description: z.string().max(4000).nullable().optional().describe("Account description."),
  parentId: uuidString("parentId must be a valid id")
    .nullable()
    .optional()
    .describe("Parent summary account id from the account register."),
  isSummary: z.boolean().optional().describe("Whether the account is a non-posting summary."),
  isActive: z.boolean().optional().describe("Whether the account is active for new postings."),
  currencyRestriction: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "currencyRestriction must be a three-letter currency code")
    .nullable()
    .optional()
    .describe("Three-letter currency restriction, or null for no restriction."),
  eliminate: z.boolean().optional().describe("Whether the account participates in eliminations."),
  subsidiaryId: uuidString("subsidiaryId must be a valid id")
    .nullable()
    .optional()
    .describe("Owning subsidiary id, or null for the shared chart."),
  subsidiaryIncludeChildren: z
    .boolean()
    .optional()
    .describe("Whether subsidiary-scoped reports include child subsidiaries."),
  reconcilable: z.boolean().optional().describe("Whether the account can be reconciled."),
  monetary: z.boolean().nullable().optional().describe("Whether the account is monetary."),
  requiredDimensions: z
    .array(z.string().trim().min(1))
    .max(128)
    .optional()
    .describe("Dimension keys required on postings to this account."),
  custom: z
    .record(z.string(), z.json())
    .optional()
    .describe("Custom field values for this account."),
};
