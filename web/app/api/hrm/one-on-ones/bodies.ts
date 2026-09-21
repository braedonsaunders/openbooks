import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/one-on-ones/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). Authority stays structural in the service (the pair, the
 * line manager, or HR); the boundary pins the shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

const recurrence = z.object({
  every_weeks: z.number().int().min(1).max(12),
  weekday: z.number().int().min(0).max(6),
  time: z.string().regex(/^\d{2}:\d{2}$/, "must be HH:MM").nullable().optional(),
});

export const scheduleOneOnOneBody = z.object({
  managerEmploymentId: uuid,
  reportEmploymentId: uuid,
  scheduledAt: z.string().datetime({ offset: true }),
  recurrence: recurrence.nullable().optional(),
});

export const patchOneOnOneBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("hold") }),
  z.object({ action: z.literal("skip"), reason: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("cancel") }),
]);

export const addOneOnOneItemBody = z.object({
  kind: z.enum(["talking_point", "action_item", "note"]),
  body: z.string().trim().min(1).max(4000),
  visibility: z.enum(["shared", "private"]).optional(),
  assigneePartyId: uuid.nullable().optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").nullable().optional(),
});

export const patchOneOnOneItemBody = z.object({
  itemId: uuid,
  done: z.boolean(),
});
