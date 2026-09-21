import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/** Typed request bodies for /api/hrm/recruiting/kits/*. */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const createKitBody = z.object({
  name: z.string().trim().min(1).max(120),
  pipelineStageId: uuid.nullable().optional(),
  instructions: z.string().max(4000).nullable().optional(),
  ratingScale: z.array(z.enum(["strong_no", "no", "yes", "strong_yes"])).min(2).max(4).optional(),
});

export const setKitActiveBody = z.object({
  action: z.literal("setActive"),
  isActive: z.boolean(),
});

export const createAttributeBody = z.object({
  category: z.string().trim().min(1).max(120),
  attribute: z.string().trim().min(1).max(240),
  description: z.string().max(2000).nullable().optional(),
  position: z.number().int().min(0).max(1000),
  isFocusDefault: z.boolean().optional(),
});

export const createQuestionBody = z.object({
  question: z.string().trim().min(1).max(2000),
  position: z.number().int().min(0).max(1000),
  attributeId: uuid.nullable().optional(),
});
