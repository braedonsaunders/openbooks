import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/** Typed request bodies for /api/hrm/recruiting/interviews/*. */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const scheduleInterviewBody = z.object({
  applicationId: uuid,
  kind: z.enum(["phone", "video", "onsite", "panel", "assessment"]),
  scheduledAt: z.string().trim().min(1).max(40),
  durationMinutes: z.number().int().positive().nullable().optional(),
  location: z.string().trim().min(1).max(240).nullable().optional(),
  panelPartyIds: z.array(uuid).max(20).nullable().optional(),
  // HR-18: optional structured-interview kit plus per-panelist focus pins.
  kitId: uuid.nullable().optional(),
  panelFocus: z.record(z.string(), z.array(uuid).max(20)).optional(),
});

export const patchInterviewBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("complete"),
    outcome: z.enum(["advance", "hold", "reject"]),
    feedback: z.string().max(4000).nullable().optional(),
    scorecard: z.unknown().optional(),
  }),
  z.object({ action: z.literal("cancel") }),
]);
