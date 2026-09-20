import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/enrollment-windows/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). The engine windows service owns the full contract (overlap,
 * scope, pending-cancellation atomicity); the boundary pins the shape.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const createWindowBody = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["open_enrollment", "new_hire", "life_event"]),
  opensOn: civilDate,
  closesOn: civilDate,
  planYearStartOn: civilDate,
  employerSubsidiaryId: uuid.nullish(),
  departmentId: uuid.nullish(),
});

export const emptyBody = z.object({});

export const closeWindowBody = z.object({
  reason: z.string().trim().min(1, "reason required").max(2000),
});
