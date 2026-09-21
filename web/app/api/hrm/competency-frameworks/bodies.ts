import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/competency-frameworks/*,
 * /api/hrm/competencies/* and /api/hrm/competency-links/*. Authority
 * stays HR (hrm.performance.manage) in the service; the boundary pins
 * the shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const createFrameworkBody = z.object({
  name: z.string().trim().min(1).max(240),
  appliesTo: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const patchFrameworkBody = z.object({
  action: z.literal("setActive"),
  isActive: z.boolean(),
});

export const createCompetencyBody = z.object({
  frameworkId: uuid,
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
});

export const addCompetencyLevelBody = z.object({
  competencyId: uuid,
  levelRank: z.number().int().min(1).max(20),
  label: z.string().trim().min(1).max(240),
  expectation: z.string().trim().min(1).max(4000),
});

export const linkCompetencyBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("link"),
    competencyId: uuid,
    targetKind: z.enum(["job_level", "position", "review_template_section"]),
    targetId: uuid,
  }),
  z.object({
    action: z.literal("attachSection"),
    sectionId: uuid,
    competencyId: uuid.nullable(),
  }),
]);
