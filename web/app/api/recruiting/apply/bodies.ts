import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/** Typed request bodies for the public apply route (with abuse controls). */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const applyBody = z.object({
  postingId: uuid,
  displayName: z.string().trim().min(1).max(240),
  email: z.string().trim().min(3).max(240).nullable().optional(),
  phone: z.string().trim().min(1).max(60).nullable().optional(),
  consentFutureRoles: z.boolean().optional(),
  // Honeypot: a human never fills this; a bot filling it is refused
  // silently (a 201-shaped refusal that writes nothing — the bot learns
  // nothing, the funnel stays clean). The length cap keeps the parse
  // honest; the route shapes the refusal, never the schema.
  website: z.string().max(2000).optional(),
});
