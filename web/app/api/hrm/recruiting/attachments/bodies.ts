import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/**
 * Typed request body for POST /api/hrm/recruiting/attachments: one call
 * that stores the prospect and the candidacy together. mergeInto names
 * the surviving candidate when the email already exists.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const attachCandidateBody = z.object({
  requisitionId: uuid,
  displayName: z.string().trim().min(1).max(240),
  email: z.string().trim().min(1).max(254).nullable().optional(),
  phone: z.string().trim().min(1).max(60).nullable().optional(),
  mergeInto: uuid.nullable().optional(),
});
