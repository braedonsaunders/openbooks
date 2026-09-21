import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/change-requests/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). Kept apart from _lib so the error mapping stays importable
 * from plain unit tests. The engine's validateChangePayload owns the full
 * payload contract; the boundary pins the shape it can pin — a payload is
 * an object naming its kind.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
export const changeRequestPayloadShape = z.looseObject({ kind: z.string().trim().min(1) });
export const createChangeRequestBody = z.object({
  employmentId: uuid,
  payload: changeRequestPayloadShape,
});
export const patchChangeRequestBody = z.object({ payload: changeRequestPayloadShape });
export const submitChangeRequestBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
  // HR-16 action/reason classification (0227): required on submit only
  // while the hrmActionReasons feature is on; ignored when off.
  action: z.string().trim().min(1).max(60).optional(),
  reasonCode: z.string().trim().min(1).max(120).optional(),
});
export const withdrawChangeRequestBody = z.object({
  reason: z.string().trim().min(1, "reason required").max(500),
});
