import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/me/* (financial-boundary ratchet:
 * every JSON mutation route parses a typed zod schema, never the bare
 * object). The engine's profile contract owns the full field validation;
 * the boundary pins the shape it can pin — changes is an object naming
 * the profile_change kind, the employment binds the actor's own record,
 * and the reason is required because HR approves people, not diffs.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
export const fileProfileChangeBody = z.object({
  employmentId: uuid,
  changes: z.looseObject({ kind: z.string().trim().min(1) }),
  reason: z.string().trim().min(1, "reason required").max(500),
});

const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const acknowledgeReviewBody = z.object({
  reviewId: uuid,
});

export const submitSelfAssessmentBody = z.object({
  reviewId: uuid,
  answers: z.array(
    z.object({
      answerId: uuid,
      rating: z.union([z.string(), z.number()]).nullish(),
      text: z.string().nullish(),
    }),
  ),
  overallRating: z.union([z.string(), z.number()]).nullish(),
});

export const goalProgressBody = z.object({
  goalId: uuid,
  progressPercent: z.number(),
  note: z.string().max(2000).nullish(),
});

export const electBenefitBody = z.object({
  employmentId: uuid,
  planId: uuid,
  windowId: uuid.nullish(),
  coverageLevelKey: z.string().trim().min(1).nullish(),
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullish(),
  lifeEventReason: z.string().trim().min(1).max(500).nullish(),
});

export const changeBenefitBody = z.object({
  enrollmentId: uuid,
  changeDate: civilDate,
  coverageLevelKey: z.string().trim().min(1).nullish(),
  reason: z.string().trim().min(1, "reason required").max(500),
});
