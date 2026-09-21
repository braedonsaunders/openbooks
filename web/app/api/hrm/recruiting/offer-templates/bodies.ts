import { z } from "zod";

/** Typed request bodies for /api/hrm/recruiting/offer-templates. */
export const createOfferTemplateBody = z.object({
  name: z.string().trim().min(1).max(120),
  bodyTemplate: z.string().trim().min(1).max(20000),
  clauses: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(120),
        label: z.string().trim().min(1).max(240).optional(),
        body: z.string().trim().min(1).max(8000),
        default_on: z.boolean().optional(),
      }),
    )
    .max(60)
    .optional(),
  approvalRequired: z.boolean().optional(),
});
