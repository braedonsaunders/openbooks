/** Shared validation for edits and posted correction payloads. */
import { z } from 'zod';
const jsonObjectSchema = z.record(z.string(), z.json());
const documentLineSchema = z.object({
  // An intentionally blank account reaches document-edit's line-numbered
  // refusal, which names the missing posting prerequisite for the operator.
  lineId: z.string().uuid().nullable().optional(), accountId: z.union([z.string().uuid(), z.literal('')]),
  amount: z.string(), description: z.string().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(), taxGroupId: z.string().uuid().nullable().optional(),
  taxOverridden: z.boolean().optional(), taxAmount: z.string().nullable().optional(),
  itemId: z.string().uuid().nullable().optional(), quantity: z.string().nullable().optional(),
  unit: z.string().nullable().optional(), unitPrice: z.string().nullable().optional(),
  partyId: z.string().uuid().nullable().optional(), departmentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), locationId: z.string().uuid().nullable().optional(),
  classId: z.string().uuid().nullable().optional(), stockLocationId: z.string().uuid().nullable().optional(),
  inventoryReturnSource: z.object({ movementId: z.string().uuid(), lotId: z.string().uuid().nullable().optional(), serialId: z.string().uuid().nullable().optional() }).nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(), custom: jsonObjectSchema.optional(),
  distributionKey: z.string().uuid().nullable().optional(), distributionGroupId: z.string().uuid().nullable().optional(),
  distributionLocked: z.boolean().nullable().optional(),
});
export const documentEditBodySchema = z.object({
  expectedUpdatedAt: z.string().min(1).optional(), lines: z.array(documentLineSchema).optional(),
  subsidiaryId: z.string().uuid().nullable().optional(),
  partyId: z.string().uuid().nullable().optional(), paymentCardId: z.string().uuid().nullable().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  referenceNumber: z.string().nullable().optional(), memo: z.string().nullable().optional(),
  postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(), projectId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(), classId: z.string().uuid().nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(), expectedPayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  paymentHoldReason: z.string().nullable().optional(), internalNotes: z.string().nullable().optional(),
  billingMethod: z.string().nullable().optional(), isFinalInvoice: z.boolean().optional(), currency: z.string().optional(),
  custom: jsonObjectSchema.optional(), unsplitDistributionGroups: z.array(z.string().uuid()).optional(),
});

export const documentCorrectionBodySchema = documentEditBodySchema.extend({
  expectedUpdatedAt: z.string().min(1),
  amendmentReason: z.string().trim().min(8).max(500),
});
