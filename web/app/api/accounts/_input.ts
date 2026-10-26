import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { ACCOUNT_TYPES } from "@openbooks/schema";

// Both create and edit must reject malformed policy values before nullable
// text normalization or PostgreSQL boolean coercion can reinterpret them.
export const accountInputFields = {
  number: z.string().trim().max(80).nullable().optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  description: z.string().nullable().optional(),
  parentId: uuidString("parentId must be a valid id").nullable().optional(),
  isSummary: z.boolean().optional(),
  isActive: z.boolean().optional(),
  currencyRestriction: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "currencyRestriction must be a three-letter currency code")
    .nullable()
    .optional(),
  eliminate: z.boolean().optional(),
  subsidiaryId: uuidString("subsidiaryId must be a valid id").nullable().optional(),
  subsidiaryIncludeChildren: z.boolean().optional(),
  reconcilable: z.boolean().optional(),
  monetary: z.boolean().nullable().optional(),
  requiredDimensions: z.array(z.string().trim().min(1)).optional(),
  custom: z.record(z.string(), z.json()).optional(),
};
