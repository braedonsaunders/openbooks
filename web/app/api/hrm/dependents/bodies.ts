import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/dependents/*. Identity (which
 * employment a dependent belongs to) is set at create and immutable —
 * updates edit descriptors only, never move a person between workers.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const createDependentBody = z.object({
  employmentId: uuid,
  relationship: z.enum(["spouse", "partner", "child", "other"]),
  displayName: z.string().trim().min(1).max(200),
  birthDate: civilDate.nullish(),
});

export const updateDependentBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    relationship: z.enum(["spouse", "partner", "child", "other"]).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    birthDate: civilDate.nullish(),
  }),
  z.object({ action: z.literal("deactivate") }),
]);
