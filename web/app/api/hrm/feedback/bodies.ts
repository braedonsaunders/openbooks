import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/feedback/*, /api/hrm/feedback/requests
 * and /api/hrm/feedback/[id]/retract. Authority stays in the service (the
 * visibility matrix, author-or-HR retraction); the boundary pins shape.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const writeFeedbackBody = z.object({
  subjectEmploymentId: uuid,
  kind: z.enum(["praise", "feedback", "request"]),
  visibility: z.enum(["public", "manager_and_subject", "manager_only", "subject_only"]),
  body: z.string().trim().min(1).max(4000),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  requestedFromPartyId: uuid.nullable().optional(),
});

export const fulfillRequestBody = z.object({
  requestId: uuid,
  visibility: z.enum(["manager_and_subject", "manager_only", "subject_only"]),
  body: z.string().trim().min(1).max(4000),
});
