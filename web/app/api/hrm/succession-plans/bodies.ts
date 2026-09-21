import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/succession-plans/*. Authority stays
 * HR (hrm.performance.manage) in the service; the boundary pins the
 * shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const createSuccessionPlanBody = z.object({
  positionId: uuid,
  incumbentEmploymentId: uuid.nullable().optional(),
});

export const patchSuccessionPlanBody = z.object({
  status: z.enum(["draft", "active", "archived"]),
});
