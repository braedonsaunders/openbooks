import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/talent-reviews/* and
 * /api/hrm/succession-plans/*. Both are HR-only in the service (the
 * subject never reads them); the boundary pins the shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const recordTalentReviewBody = z.object({
  employmentId: uuid,
  cycleId: uuid.nullable().optional(),
  performanceKey: z.string().trim().min(1).max(240),
  potentialKey: z.string().trim().min(1).max(240),
  impactOfLoss: z.enum(["low", "medium", "high"]),
  riskOfLoss: z.enum(["low", "medium", "high"]),
  promotionReady: z.boolean().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export const createSuccessionPlanBody = z.object({
  positionId: uuid,
  incumbentEmploymentId: uuid.nullable().optional(),
});

export const patchSuccessionPlanBody = z.object({
  action: z.literal("setStatus"),
  status: z.enum(["draft", "active", "archived"]),
});

export const addSuccessionCandidateBody = z.object({
  employmentId: uuid,
  readiness: z.enum(["ready_now", "one_to_two_years", "three_plus"]),
  notes: z.string().trim().max(2000).nullable().optional(),
});
