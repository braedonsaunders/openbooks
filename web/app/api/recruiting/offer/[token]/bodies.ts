import { z } from "zod";

/** Typed request bodies for the public offer-signing route. */
export const signOfferBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("sign"),
    signerName: z.string().trim().min(1).max(240),
    // Optional client-observed hash; the service seals its own latest
    // render and refuses when the two disagree.
    documentHash: z.string().trim().min(1).max(128).nullable().optional(),
    renderedFileId: z.string().trim().min(1).max(80).nullable().optional(),
  }),
  z.object({
    action: z.literal("decline"),
    reason: z.string().trim().min(1).max(2000),
  }),
]);
