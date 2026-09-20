import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/reviews/* (financial-boundary ratchet:
 * every JSON mutation route parses a typed zod schema, never the bare
 * object). Authorship stays identity-based in the service (reviewer,
 * subject, or HR) — the boundary pins the answer shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const decimal = z.union([z.string(), z.number()]);
const reason = z.string().trim().min(1, "reason required").max(2000);

const answer = z.object({
  answerId: uuid,
  rating: decimal.nullable().optional(),
  text: z.string().max(8000).nullable().optional(),
});

export const patchReviewBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), answers: z.array(answer).min(1), overallRating: decimal.nullable().optional() }),
  z.object({ action: z.literal("calibrate"), calibratedRating: decimal, reason }),
  z.object({ action: z.literal("share") }),
  z.object({ action: z.literal("acknowledge") }),
  z.object({ action: z.literal("reopen"), reason }),
]);
