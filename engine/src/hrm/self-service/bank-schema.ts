import { z } from "zod";

/**
 * bank_change payload contracts (self-service direct deposit).
 *
 * Two shapes, one boundary: the PROPOSAL carries the plaintext account
 * number exactly as typed and never persists — the file service validates
 * it, seals it in memory, and files only the STORED shape. Storage,
 * audit, and notifications carry the sealed text and the last four at
 * most; the full number never lands in a table, a log, or an email.
 *
 * A leaf module — zod only, zero engine imports — so the change-request
 * service (which owns the kind vocabulary and the approval application)
 * and the self-service orchestration share the stored contract with no
 * import cycle. Field rules mirror the party bank account boundary
 * (bank name required, account number at least 4 characters, routing a
 * small string map); the reason rides the request, 5–500 characters,
 * because a replacement retires the prior row with it as evidence.
 */

const nonBlank = (field: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${field} must not be blank`)
    .max(max, `${field} must be at most ${max} characters`);

/** Plaintext proposal: validated, sealed in memory, never stored. */
export const bankChangeProposalSchema = z
  .object({
    bankName: nonBlank("bank.bankName", 240),
    accountNumber: z
      .string()
      .trim()
      .min(4, "bank.accountNumber must be at least 4 characters")
      .max(64, "bank.accountNumber must be at most 64 characters"),
    country: z.string().trim().max(64, "bank.country must be at most 64 characters").nullable().optional(),
    currency: z.string().trim().max(3, "bank.currency must be at most 3 characters").nullable().optional(),
    routing: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Stored proposal: sealed account plus the masked echo, nothing more. */
export const bankChangePayloadSchema = z
  .object({
    kind: z.literal("bank_change"),
    bankName: nonBlank("bank.bankName", 240),
    country: z.string().trim().max(64).nullable().optional(),
    currency: z.string().trim().max(3).nullable().optional(),
    routing: z.record(z.string(), z.string()).optional(),
    sealedAccount: nonBlank("bank.sealedAccount", 4000),
    accountLastFour: z
      .string()
      .trim()
      .min(4, "bank.accountLastFour must be 4 characters")
      .max(4, "bank.accountLastFour must be 4 characters"),
  })
  .strict();

export type BankChangeProposal = z.infer<typeof bankChangeProposalSchema>;
export type BankChangePayload = z.infer<typeof bankChangePayloadSchema>;
