import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm qualification routes. Every JSON
 * mutation route parses a typed zod schema, never the bare object; the
 * engine service owns the full contract.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const text255 = z.string().trim().min(1).max(255);

export const createQualificationTypeBody = z.object({
  code: text255,
  name: z.string().trim().min(1).max(240),
  category: text255,
  issuingBody: z.string().trim().max(240).nullable().optional(),
  validityMonths: z.number().int().positive().nullable().optional(),
  renewalLeadDays: z.number().int().min(0).optional(),
  requiresEvidence: z.boolean().optional(),
});

export const updateQualificationTypeBody = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  category: text255.optional(),
  issuingBody: z.string().trim().max(240).nullable().optional(),
  validityMonths: z.number().int().positive().nullable().optional(),
  renewalLeadDays: z.number().int().min(0).optional(),
  requiresEvidence: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const recordQualificationBody = z.object({
  employmentId: uuid,
  typeId: uuid,
  identifier: z.string().trim().max(120).nullable().optional(),
  issuedOn: civilDate,
  expiresOn: civilDate.nullable().optional(),
  evidenceFileId: uuid.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const verifyQualificationBody = z.object({
  reason: z.string().trim().max(2000).nullable().optional(),
});

export const renewQualificationBody = z.object({
  issuedOn: civilDate,
  expiresOn: civilDate.nullable().optional(),
  evidenceFileId: uuid.nullable().optional(),
  identifier: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const revokeQualificationBody = z.object({
  reason: z.string().trim().min(1).max(2000),
});

export const attachEvidenceBody = z.object({
  fileId: uuid,
});

export const setRequirementBody = z.object({
  subjectKind: z.enum(["project", "equipment", "position", "classification"]),
  subjectId: uuid,
  typeId: uuid,
  requiredFrom: civilDate.optional(),
  requiredTo: civilDate.nullable().optional(),
  severity: z.enum(["block", "warn"]).optional(),
});

export const checkAssignmentBody = z.object({
  employmentId: uuid,
  subjectKind: z.enum(["project", "equipment", "position", "classification"]),
  subjectId: uuid,
  on: civilDate.optional(),
});

export const declareCategoryBody = z.object({
  category: text255,
});

export const qualificationStatusFilter = z.enum(["valid", "expiring", "expired", "revoked", "pending_verification"]);
