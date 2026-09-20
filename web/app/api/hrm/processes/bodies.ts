import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/processes/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). The engine owns the full contract; the boundary pins the
 * shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const openProcessBody = z.object({
  employmentId: uuid,
  kind: z.enum(["onboarding", "offboarding", "transfer"]),
  effectiveDate: civilDate,
  templateId: uuid.optional(),
});

export const completeStepBody = z.object({
  attachmentId: uuid.optional(),
});

export const skipStepBody = z.object({
  reason: z.string().trim().min(1, "reason required").max(2000),
});

export const cancelProcessBody = z.object({
  reason: z.string().trim().min(1, "reason required").max(2000),
});
