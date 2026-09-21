import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/surveys (financial-boundary ratchet:
 * every JSON mutation route parses a typed zod schema, never the bare
 * object). Authoring and results stay HR (surveys manage); responding
 * rides invitation tokens on the public route, never a grant.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

const questionInput = z.object({
  kind: z.enum(["scale", "enps", "text", "single", "multi"]),
  prompt: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  driverKey: z.string().trim().min(1).max(80).optional(),
});

export const saveSurveyBody = z.object({
  surveyId: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["engagement", "pulse", "onboarding", "exit", "custom"]),
  anonymity: z.enum(["anonymous", "confidential", "named"]),
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
  audience: z.record(z.string(), z.unknown()).optional(),
  recurrence: z.record(z.string(), z.unknown()).nullable().optional(),
  minGroupSize: z.number().int().min(2).max(1000).optional(),
  questions: z.array(questionInput).min(1).max(100),
});

export const openSurveyBody = z.object({
  partyIds: z.array(uuid).min(1).max(5000),
});

export const submitAnswersBody = z.object({
  answers: z
    .array(z.object({ questionId: uuid, value: z.unknown() }))
    .min(1)
    .max(100),
});
