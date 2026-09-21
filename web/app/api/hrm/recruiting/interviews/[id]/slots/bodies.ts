import { z } from "zod";

/** Typed request bodies for interviews/[id]/slots. */
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
    .max(40),
  expiresAt: z.string().trim().min(1).max(40).nullable().optional(),
});
