import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/** Typed request bodies for /api/hrm/recruiting/talent-pools. */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const createTalentPoolBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
});

export const addPoolMemberBody = z.object({
  candidateId: uuid,
  note: z.string().max(2000).nullable().optional(),
});

export const removePoolMemberBody = z.object({
  action: z.literal("remove"),
  candidateId: uuid,
});

export const tagCandidateBody = z.object({
  action: z.literal("tag"),
  candidateId: uuid,
  tags: z.array(z.string().trim().min(1).max(80)).max(40),
});

export const rediscoverBody = z.object({
  requisitionId: uuid,
  requisitionTags: z.array(z.string().trim().min(1).max(80)).max(40),
});
