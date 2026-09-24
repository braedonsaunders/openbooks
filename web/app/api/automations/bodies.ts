import { z } from "zod";

const uuid = z.string().uuid("must be a valid id");

export const createAutomationBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  trigger: z.unknown(),
  rules: z.unknown().nullish(),
  conditions: z.unknown().nullish(),
  actions: z.unknown(),
  priority: z.number().int().min(0).max(1000).nullish(),
});

export const patchAutomationBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullish(),
  trigger: z.unknown().optional(),
  rules: z.unknown().optional(),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

export const automationStatusBody = z.object({
  status: z.enum(["enabled", "disabled"]),
});

export const runAutomationBody = z.object({
  subjectEntity: z.string().min(1).nullish(),
  subjectId: uuid.nullish(),
});

export const simulateAutomationBody = z.object({
  subjectEntity: z.string().min(1).nullish(),
  subjectId: uuid.nullish(),
  sampleSize: z.number().int().min(1).max(20).nullish(),
});

export const approvalSettingsBody = z.object({
  subjectKind: z.string().min(1),
  exceptionOnly: z.boolean(),
  thresholds: z.record(z.string(), z.unknown()).nullish(),
  autoApproveWhenNoRule: z.boolean().nullish(),
  delegateAfterDays: z.number().int().min(1).nullish(),
  excludeInitiator: z.boolean().nullish(),
});

export const actionReasonRouteBody = z.object({
  action: z.string().min(1),
  reasonCode: z.string().trim().min(1),
  label: z.string().trim().min(1),
  requiresComment: z.boolean().nullish(),
  isActive: z.boolean().nullish(),
});

export const rescindBody = z.object({
  reason: z.string().trim().min(1, "reason required").max(2000),
});

export const correctBody = z.object({
  reason: z.string().trim().min(1, "reason required").max(2000),
  correctedFields: z.record(z.string(), z.unknown()).nullish(),
  prefillPayload: z.looseObject({ kind: z.string().trim().min(1) }).nullish(),
});
