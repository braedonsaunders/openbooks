import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";

const UUID = z.string().regex(UUID_RE).describe("Organization-owned record UUID.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");

export const billingPreflightBody = z
  .object({
    provider: z
      .enum(["chargebee", "recurly", "maxio", "zuora"])
      .describe("Billing platform that owns the history to import."),
    externalAccount: z.string().min(1).max(255).describe("Provider account or site name."),
    apiKey: z.string().min(1).max(4096).describe("Provider API key used only to run this import."),
    site: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe("Provider site identifier when the selected platform requires one."),
  })
  .strict();

export const billingImportByIdBody = z
  .object({ runId: UUID.describe("Billing history import run UUID from the run list.") })
  .strict();

export const billingImportConfigBody = z
  .object({
    mode: z
      .enum(["post_historical", "opening_balances"])
      .optional()
      .describe("Import historical transactions or create opening balances at cut-over."),
    cutoverOn: DATE.nullable()
      .optional()
      .describe("Opening-balance cut-over date in YYYY-MM-DD format, or null."),
    historyDepthMonths: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe("Number of historical months to import, or null for the provider default."),
    incomeAccountId: UUID.nullable()
      .optional()
      .describe("OpenBooks income account UUID for imported revenue, or null."),
    clearingAccountId: UUID.nullable()
      .optional()
      .describe("OpenBooks clearing account UUID for imported receipts, or null."),
    taxCodeId: UUID.nullable()
      .optional()
      .describe("OpenBooks tax code UUID for imported invoices, or null."),
    planMap: z
      .record(z.string(), UUID)
      .optional()
      .describe("Map provider plan ids to OpenBooks subscription plan UUIDs."),
    customerMap: z
      .record(z.string(), UUID)
      .optional()
      .describe("Map provider customer ids to OpenBooks customer UUIDs."),
    autoSync: z.boolean().optional().describe("Enable ongoing synchronization after acceptance."),
  })
  .strict();

export const acceptBillingImportBody = z
  .object({
    runId: UUID.describe("Billing history import run UUID from the run list."),
    config: billingImportConfigBody.describe("Mappings and import policy to accept for this run."),
  })
  .strict();
