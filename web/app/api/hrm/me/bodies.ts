import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/me/* (financial-boundary ratchet:
 * every JSON mutation route parses a typed zod schema, never the bare
 * object). The engine's profile contract owns the full field validation;
 * the boundary pins the shape it can pin — changes is an object naming
 * the profile_change kind, the employment binds the actor's own record,
 * and the reason is required because HR approves people, not diffs.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
export const fileProfileChangeBody = z.object({
  employmentId: uuid,
  changes: z.looseObject({ kind: z.string().trim().min(1) }),
  reason: z.string().trim().min(1, "reason required").max(500),
});
