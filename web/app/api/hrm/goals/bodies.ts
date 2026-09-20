import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/goals/* (financial-boundary ratchet:
 * every JSON mutation route parses a typed zod schema, never the bare
 * object). Authority stays subject-or-HR in the service; the boundary pins
 * the shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const decimal = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal");
const note = z.string().trim().min(1).max(2000);

export const createGoalBody = z.object({
  employmentId: uuid,
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).nullable().optional(),
  dueOn: civilDate.nullable().optional(),
  weight: decimal.nullable().optional(),
  cycleId: uuid.nullable().optional(),
});

export const patchGoalBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("progress"), progressPercent: z.number().int().min(0).max(100), note: note.nullable().optional() }),
  z.object({ action: z.literal("achieve") }),
  z.object({ action: z.literal("miss"), note }),
  z.object({ action: z.literal("cancel"), note }),
]);
