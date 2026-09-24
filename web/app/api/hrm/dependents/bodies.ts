import { z } from "zod";
import { civilDateInput } from "@/lib/api/civil-date";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/dependents/*. Identity (which
 * employment a dependent belongs to) is set at create and immutable —
 * updates edit descriptors only, never move a person between workers.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = civilDateInput();

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
