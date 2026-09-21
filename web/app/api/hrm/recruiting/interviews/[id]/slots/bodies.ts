import { z } from "zod";

/**
 * Typed request bodies for interviews/[id]/slots. Windows may ride an
 * interviewer pool (poolId) instead of arriving explicitly — the service
 * refuses the request by name when neither arrives, so the schema stays
 * permissive and the refusal carries the remedy.
 */
export const proposeSlotsBody = z.object({
  windows: z
    .array(
      z.object({
        startsAt: z.string().trim().min(1).max(40),
        endsAt: z.string().trim().min(1).max(40),
        timezone: z.string().trim().min(1).max(80),
      }),
    )
    .min(1)
    .max(40)
    .optional(),
  poolId: z.string().trim().min(1).max(40).optional(),
  expiresAt: z.string().trim().min(1).max(40).nullable().optional(),
});
