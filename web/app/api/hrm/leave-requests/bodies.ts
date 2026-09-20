import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/leave-requests/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). Kept apart from _lib so the error mapping stays importable
 * from plain unit tests. The engine leave service owns the full contract
 * (live employment per day, overlap, time balance, notice); the boundary
 * pins the shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");
const exactHours = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "must be an exact decimal with at most 2 fraction digits");

export const fileLeaveRequestBody = z.object({
  employmentId: uuid,
  leaveTypeId: uuid,
  startsOn: civilDate,
  endsOn: civilDate,
  hours: exactHours,
  reason: z.string().trim().min(1).max(2000).nullish(),
  onBehalf: z.boolean().optional(),
});

export const leaveDecisionBody = z.object({
  reason: z.string().trim().min(1, "reason required").max(2000),
});

export const recordLeaveAttachmentBody = z.object({
  attachmentId: uuid,
});

export const recordAbsenceBody = z.object({
  employmentId: uuid,
  leaveTypeId: uuid,
  onDate: civilDate,
  hours: exactHours,
});
