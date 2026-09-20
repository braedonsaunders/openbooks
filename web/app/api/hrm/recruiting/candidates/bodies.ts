import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/recruiting/candidates/*.
 * mergeInto names the surviving candidate when the email already exists:
 * no new record is created and the application attaches to the survivor.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const createCandidateBody = z.object({
  displayName: z.string().trim().min(1).max(240),
  email: z.string().trim().min(1).max(254).nullable().optional(),
  phone: z.string().trim().min(1).max(60).nullable().optional(),
  source: z.enum(["referral", "job_board", "agency", "direct", "internal", "other"]).nullable().optional(),
  sourceDetail: z.string().max(500).nullable().optional(),
  resumeAttachmentId: uuid.nullable().optional(),
  isInternal: z.boolean().optional(),
  notes: z.string().max(4000).nullable().optional(),
  mergeInto: uuid.nullable().optional(),
});
