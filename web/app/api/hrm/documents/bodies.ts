import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/documents (financial-boundary ratchet:
 * every JSON mutation route parses a typed zod schema, never the bare
 * object). Uploads carry base64 file bytes (10 MB cap — HR letters, not
 * archives); the service refuses empty files by name.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const generateDocumentBody = z.object({
  templateId: uuid,
  employmentId: uuid.nullable().optional(),
  partyId: uuid,
  title: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const uploadDocumentBody = z.object({
  employmentId: uuid.nullable().optional(),
  partyId: uuid,
  categoryKey: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(160),
  contentType: z.string().trim().min(1).max(120),
  fileBase64: z.string().min(1).max(14_000_000),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const voidDocumentBody = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const holdDocumentBody = z.object({
  hold: z.boolean(),
});

export const signActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sign"), name: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal("decline"), reason: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("acknowledge") }),
]);

export { civilDate };
