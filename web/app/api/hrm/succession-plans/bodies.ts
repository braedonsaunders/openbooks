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
  notes: z.string().nullable().optional(),
});

export const patchSuccessionPlanBody = z.object({
  status: z.enum(["draft", "active", "archived"]).optional(),
  notes: z.string().nullable().optional(),
}).refine((body) => (body.status === undefined) !== (body.notes === undefined), {
  message: "provide exactly one succession plan status or notes change",
});
