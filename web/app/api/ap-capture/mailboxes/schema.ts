import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { INBOUND_EMAIL_PROVIDERS } from "@openbooks/engine/payables/ap-capture-service";

/**
 * Request contracts for inbound AP addresses. The shared setup drawer sends
 * the allowed-sender list as JSON text and empty text fields as null; both
 * shapes are accepted here and normalized before the engine validates them.
 */

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable(),
  );

const senderList = z.preprocess(
  (value) => {
    if (value === null || value === undefined || value === "") return [];
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  },
  z.array(z.string().max(320)).max(200),
);

const mailboxFields = {
  label: z.string().trim().min(1).max(120),
  emailAddress: optionalText(320),
  provider: z.enum(INBOUND_EMAIL_PROVIDERS),
  allowedSenders: senderList,
  isActive: z.boolean(),
  signingSecret: optionalText(512),
};

export const createMailboxBody = z.strictObject({
  subsidiaryId: uuidString(),
  ...mailboxFields,
});

export const updateMailboxBody = z.strictObject({
  ...mailboxFields,
  clearSigningSecret: z.boolean().nullable().optional(),
  rotateToken: z.boolean().nullable().optional(),
});

/** Make the caller the address owner, with the reason the audit trail records. */
export const takeMailboxOwnershipBody = z.strictObject({
  takeOwnership: z.literal(true),
  reason: z.string().trim().min(5).max(2000),
});

/** A PATCH is either a configuration update or an ownership transfer, never both. */
export const patchMailboxBody = z.union([takeMailboxOwnershipBody, updateMailboxBody]);
