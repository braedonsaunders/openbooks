import { z } from "zod";
import { isUuid } from "../../../../../../../lib/list-params";

/** Typed request bodies for offers/[id]/versions (render a new version). */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const renderOfferVersionBody = z.object({
  templateId: uuid,
  selectedClauseKeys: z.array(z.string().trim().min(1).max(120)).max(60).optional(),
  renderedFileId: uuid.nullable().optional(),
});
