import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/review-cycles/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). The engine service owns the full contract (period shape,
 * scope visibility, guarded transitions); the boundary pins the shape it
 * can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const reason = z.string().trim().min(1, "reason required").max(2000);

const appliesTo = z
  .object({
    employer_subsidiary_id: uuid.nullable().optional(),
    department_id: uuid.nullable().optional(),
  })
  .strict()
  .optional();

export const createCycleBody = z.object({
  templateId: uuid,
  name: z.string().trim().min(1).max(240),
  periodStartOn: civilDate,
  periodEndOn: civilDate,
  selfDueOn: civilDate.nullable().optional(),
  managerDueOn: civilDate.nullable().optional(),
  appliesTo,
});

export const patchCycleBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open") }),
  z.object({ action: z.literal("to-calibrating"), force: z.boolean().optional(), forceReason: reason.optional() }),
  z.object({ action: z.literal("close") }),
]);
