import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

/** Typed request bodies for the intercompany API. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const reason = z.string().trim().min(1, "a reason is required").max(2000);

export const idParams = z.object({ id: uuidString() });

export const linkPairBody = z
  .object({
    sellerDocumentId: uuidString(),
    buyerDocumentId: uuidString(),
    reason,
  })
  .strict();

export const reasonBody = z.object({ reason }).strict();

export const counterpartBody = z.object({ documentId: uuidString() }).strict();

export const nettingBody = z
  .object({
    asOfDate: isoDate,
    subsidiaryIds: z.array(uuidString()).min(2, "choose at least two subsidiaries").max(50),
    settleCash: z.boolean().default(false),
    bankAccounts: z
      .record(uuidString(), z.record(z.string().regex(/^[A-Z]{3}$/), uuidString()))
      .default({}),
    reason: z.string().trim().max(2000).default(""),
    idempotencyKey: uuidString().nullable().optional(),
  })
  .strict();

export const reversalBody = z.object({ reversalDate: isoDate, reason }).strict();

export const transferBody = z
  .object({
    transferDate: isoDate,
    fromSubsidiaryId: uuidString(),
    toSubsidiaryId: uuidString(),
    fromBankAccountId: uuidString(),
    toBankAccountId: uuidString(),
    amount: z
      .string()
      .regex(
        /^\d+(\.\d{1,4})?$/,
        "the amount must be a positive amount with at most four decimals",
      ),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    memo: z.string().max(500).nullable().optional(),
    reason,
    idempotencyKey: uuidString().nullable().optional(),
  })
  .strict();
