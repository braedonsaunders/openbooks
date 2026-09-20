import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/** Typed request bodies for /api/hrm/recruiting/applications/*. */
const uuid = z.string().refine(isUuid, "must be a valid id");
const reason = z.string().trim().min(1, "reason required").max(2000);

export const createApplicationBody = z.object({
  requisitionId: uuid,
  candidateId: uuid,
  /** True when the candidate create merged into a survivor: recorded as evidence. */
  merged: z.boolean().optional(),
});

export const patchApplicationBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("move"),
    toStageId: uuid,
    reason: z.string().max(2000).nullable().optional(),
  }),
  z.object({ action: z.literal("reject"), reason }),
  z.object({ action: z.literal("withdraw") }),
]);
