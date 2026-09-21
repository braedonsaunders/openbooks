import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/** Typed request bodies for /api/hrm/recruiting/postings. */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const publishPostingBody = z.object({
  requisitionId: uuid,
  boardKey: z.string().trim().min(1).max(120),
});

export const transitionPostingBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("close") }),
]);
