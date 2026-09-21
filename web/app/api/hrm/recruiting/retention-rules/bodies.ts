import { z } from "zod";

/** Typed request bodies for /api/hrm/recruiting/retention-rules. */
export const createRetentionRuleBody = z.object({
  name: z.string().trim().min(1).max(120),
  regionScope: z.record(z.string(), z.unknown()).optional(),
  basis: z.enum(["inactivity", "consent"]),
  retainMonths: z.number().int().min(1).max(120),
  action: z.enum(["anonymize", "delete"]).optional(),
  consentExtensionLeadDays: z.number().int().min(1).max(365).nullable().optional(),
});
