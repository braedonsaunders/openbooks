import { z } from "zod";
import {
  automationActions,
  automationConditions,
  automationRules,
  automationTrigger,
} from "@openbooks/engine/src/automations/triggers.ts";

const uuid = z.string().uuid("must be a valid id");

export const createAutomationBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  trigger: automationTrigger,
  rules: automationRules.nullish(),
  conditions: automationConditions.nullish(),
  actions: automationActions,
  priority: z.number().int().min(0).max(1000).nullish(),
});

export const patchAutomationBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullish(),
  trigger: automationTrigger.optional(),
  rules: automationRules.nullish().optional(),
  conditions: automationConditions.nullish().optional(),
  actions: automationActions.optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  expectedVersion: z.number().int().min(1),
}).refine(
  (body) => Object.keys(body).some((key) => key !== "expectedVersion"),
  "provide at least one automation field to update",
);

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
  thresholds: z.record(z.string().min(1), z.json()).nullish(),
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
  correctedFields: z.record(z.string().min(1), z.json()).nullish(),
  prefillPayload: z
    .record(z.string().min(1), z.json())
    .refine(
      (payload) => typeof payload.kind === "string" && payload.kind.trim().length > 0,
      "prefillPayload.kind is required",
    )
    .nullish(),
});
