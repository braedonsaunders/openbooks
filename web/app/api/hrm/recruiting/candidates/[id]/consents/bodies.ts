import { z } from "zod";

/** Typed request bodies for candidates/[id]/consents. */
export const recordConsentBody = z.object({
  purpose: z.enum(["this_application", "future_roles", "talent_pool"]),
  source: z.enum(["form", "email", "import"]).optional(),
  expiresAt: z.string().trim().min(1).max(40).nullable().optional(),
});

export const withdrawConsentBody = z.object({
  action: z.literal("withdraw"),
  purpose: z.enum(["this_application", "future_roles", "talent_pool"]),
});
