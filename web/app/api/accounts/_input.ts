import { z } from 'zod'

// Both create and edit must reject malformed policy values before nullable
// text normalization or PostgreSQL boolean coercion can reinterpret them.
export const accountInputFields = {
  number: z.string().nullable().optional(),
  type: z.string().optional(),
  description: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  isSummary: z.boolean().optional(),
  isActive: z.boolean().optional(),
  currencyRestriction: z.string().nullable().optional(),
  eliminate: z.boolean().optional(),
  subsidiaryId: z.string().nullable().optional(),
  subsidiaryIncludeChildren: z.boolean().optional(),
  reconcilable: z.boolean().optional(),
  monetary: z.boolean().nullable().optional(),
  requiredDimensions: z.array(z.string()).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
}
