/** Shared validation for edits and posted correction payloads. */
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
const jsonObjectSchema = z.record(z.string(), z.json());
export const documentLineSchema = z.object({
  // A blank, null or absent account reaches document-edit's line-numbered
  // refusal, which names the missing posting prerequisite for the operator.
  lineId: uuidString().nullable().optional(),
  accountId: z
    .union([uuidString(), z.literal("")])
    .nullable()
    .optional(),
  amount: z.string(),
  description: z.string().nullable().optional(),
  taxCodeId: uuidString().nullable().optional(),
  taxGroupId: uuidString().nullable().optional(),
  withholdingTreatment: z.enum(["labour", "materials", "excluded"]).nullable().optional(),
  withholdingMaterialsCost: z.string().nullable().optional(),
  taxOverridden: z.boolean().optional(),
  taxAmount: z.string().nullable().optional(),
  marketplaceFacilitator: z.string().nullable().optional(),
  itemId: uuidString().nullable().optional(),
  quantity: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  unitPrice: z.string().nullable().optional(),
  partyId: uuidString().nullable().optional(),
  departmentId: uuidString().nullable().optional(),
  projectId: uuidString().nullable().optional(),
  locationId: uuidString().nullable().optional(),
  classId: uuidString().nullable().optional(),
  stockLocationId: uuidString().nullable().optional(),
  workFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  workTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  // Amortization: template and service window; the engine validates the calendar dates.
  amortizationTemplateId: uuidString().nullable().optional(),
  amortizationStartOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  amortizationEndOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  inventoryReturnSource: z
    .object({
      movementId: uuidString(),
      lotId: uuidString().nullable().optional(),
      serialId: uuidString().nullable().optional(),
    })
    .nullable()
    .optional(),
  inventoryAllowance: z.boolean().nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(),
  custom: jsonObjectSchema.optional(),
  distributionKey: uuidString().nullable().optional(),
  distributionGroupId: uuidString().nullable().optional(),
  distributionLocked: z.boolean().nullable().optional(),
});
export const documentEditBodySchema = z.object({
  expectedUpdatedAt: z.string().min(1).optional(),
  lines: z.array(documentLineSchema).optional(),
  subsidiaryId: uuidString().nullable().optional(),
  partyId: uuidString().nullable().optional(),
  paymentCardId: uuidString().nullable().optional(),
  documentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  postingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  departmentId: uuidString().nullable().optional(),
  projectId: uuidString().nullable().optional(),
  locationId: uuidString().nullable().optional(),
  classId: uuidString().nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(),
  expectedPayDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  workCompletedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  paymentHoldReason: z.string().nullable().optional(),
  internalNotes: z.string().nullable().optional(),
  billingMethod: z.string().nullable().optional(),
  isFinalInvoice: z.boolean().optional(),
  currency: z.string().optional(),
  explicitFx: z
    .object({
      rate: z.string(),
      source: z.string(),
      reason: z.string(),
      fromCurrency: z.string(),
      toCurrency: z.string(),
      rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict()
    .nullable()
    .optional(),
  custom: jsonObjectSchema.optional(),
  unsplitDistributionGroups: z.array(uuidString()).optional(),
});

export const documentCorrectionBodySchema = documentEditBodySchema.extend({
  expectedUpdatedAt: z.string().min(1),
  amendmentReason: z.string().trim().min(8).max(500),
});
