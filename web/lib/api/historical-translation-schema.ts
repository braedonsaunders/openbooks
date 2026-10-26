import { z } from "zod";
import { isIsoCalendarDate } from "@openbooks/engine/platform/iso-date";
import { exactMoney, uuidId } from "./json-schema";

const source = z.strictObject({
  fileId: uuidId,
  versionId: uuidId,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** The domain command retains the authoritative layer and source validation. */
export const historicalTranslationProposalBody = z.strictObject({
  instruction: z.strictObject({
    sourceLineId: uuidId,
    measurementCurrency: z.string().regex(/^[A-Z]{3}$/),
    presentationCurrency: z.string().regex(/^[A-Z]{3}$/),
    kind: z.enum(["contribution", "opening", "correction"]),
    layers: z
      .array(
        z.strictObject({
          amount: exactMoney(),
          rate: z
            .string()
            .regex(/^\d{1,9}(?:\.\d{1,10})?$/)
            .refine((value) => /[1-9]/.test(value), "Record a genuine positive historical rate."),
          historicalDate: z
            .string()
            .refine(isIsoCalendarDate, "Record a valid historical calendar date."),
          provenance: z.string().trim().min(8).max(2000),
          source,
          originalLayerId: uuidId.nullable(),
        }),
      )
      .min(1)
      .max(200),
  }),
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().min(1).max(120),
});

export const historicalTranslationSourceParams = z.object({ sourceLineId: uuidId });
export const historicalTranslationChangeParams = z.object({ changeId: uuidId });
