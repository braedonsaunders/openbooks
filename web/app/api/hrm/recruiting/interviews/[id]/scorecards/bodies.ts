import { z } from "zod";

/** Typed request bodies for interviews/[id]/scorecards. */
export const submitScorecardBody = z.object({
  overall: z.enum(["strong_no", "no", "yes", "strong_yes"]),
  ratings: z.record(z.string(), z.enum(["strong_no", "no", "yes", "strong_yes"])),
  privateNotes: z.string().max(4000).nullable().optional(),
  sharedNotes: z.string().max(4000).nullable().optional(),
});
