import { z } from "zod";
import { civilDateInput } from "@/lib/api/civil-date";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/benefit-awards/*. The award service owns
 * the full lifecycle contract (snapshots, approvals, delivery); the boundary
 * pins the shape it can pin. Value is an exact decimal, never a float;
 * voiding always carries a reason; external delivery records the provider's
 * own reference.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = civilDateInput();
const reason = z.string().trim().min(1, "reason required").max(2000);

export const createAwardBody = z.object({
  action: z.literal("create"),
  programId: uuid,
  employmentId: uuid,
  periodFrom: civilDate,
  periodTo: civilDate.nullish(),
  value: z.string().trim().min(1).max(64),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "currency is a 3-letter ISO code in capitals"),
  evidence: z.record(z.string(), z.unknown()).nullish(),
  sourceKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((key) => !/^(settle|adjust):/i.test(key), "settlement keys are issued by the settlement calculation, not manual awards")
    .nullish(),
});

export const benefitAwardPostBody = createAwardBody;

export const submitAwardBody = z.object({ action: z.literal("submit") });
export const queueAwardBody = z.object({
  action: z.literal("queue"),
  payRunDocumentId: uuid.nullish(),
  payRunAdjustmentId: uuid.nullish(),
});
export const payrollDeliveryBody = z.object({
  action: z.literal("payrollDelivery"),
  payRunDocumentId: uuid,
  payRunAdjustmentId: uuid,
});
export const externalDeliveryBody = z.object({
  action: z.literal("externalDelivery"),
  externalRef: z.string().trim().min(1).max(500),
});
export const adjustAwardBody = z.object({
  action: z.literal("adjust"),
  correctionId: uuid,
  value: z.string().trim().min(1).max(64),
  reason,
});
export const voidAwardBody = z.object({ action: z.literal("void"), reason });

export const benefitAwardPatchBody = z.discriminatedUnion("action", [
  submitAwardBody,
  queueAwardBody,
  payrollDeliveryBody,
  externalDeliveryBody,
  voidAwardBody,
  adjustAwardBody,
]);
