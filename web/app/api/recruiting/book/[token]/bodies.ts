import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/** Typed request bodies for the public booking route. */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const bookSlotBody = z.object({
  slotId: uuid,
  candidateName: z.string().trim().min(1).max(240).optional(),
});
