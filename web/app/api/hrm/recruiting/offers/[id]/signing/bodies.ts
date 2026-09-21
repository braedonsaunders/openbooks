import { z } from "zod";

/** Typed request bodies for offers/[id]/signing (send-link, void). */
export const offerSigningBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send-link"),
    candidateEmail: z.string().trim().min(3).max(240),
    candidateName: z.string().trim().min(1).max(240).optional(),
  }),
  z.object({
    action: z.literal("void"),
    reason: z.string().trim().min(1).max(2000),
  }),
]);
