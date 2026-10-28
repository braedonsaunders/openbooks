import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  createAutomation,
  AutomationServiceError,
  AutomationVersionConflictError,
  setAutomationStatus,
  updateAutomation,
} from "@openbooks/engine/automations/services";
import { executeAutomation, AutomationExecuteError } from "@openbooks/engine/automations/execute";
import { simulateAutomation } from "@openbooks/engine/automations/simulator";
import {
  automationActions,
  automationConditions,
  automationRules,
  automationTrigger,
} from "@openbooks/engine/automations/triggers";
import { isFeatureEnabled } from "../features";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("Automation id returned by automations_status.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

const createBody = z.object({
  name: z.string().trim().min(1).max(200).describe("Name shown in the automation list."),
  description: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .describe("Optional purpose of this automation."),
  trigger: automationTrigger.describe("Trigger definition accepted by the automation builder."),
  rules: automationRules.nullish().describe("Optional event rules from the automation builder."),
  conditions: automationConditions
    .nullish()
    .describe("Optional conditions from the automation builder."),
  actions: automationActions.describe("Actions to execute when the trigger and rules match."),
  priority: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .nullish()
    .describe("Execution priority; lower values run first."),
});

const updateFields = z.object({
  name: z.string().trim().min(1).max(200).optional().describe("Replacement automation name."),
  description: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .optional()
    .describe("Replacement purpose text."),
  trigger: automationTrigger.optional().describe("Replacement trigger definition."),
  rules: automationRules.nullish().optional().describe("Replacement event rules."),
  conditions: automationConditions.nullish().optional().describe("Replacement conditions."),
  actions: automationActions.optional().describe("Replacement actions."),
  priority: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Replacement execution priority."),
  expectedVersion: z.number().int().min(1).describe("Exact version from automations_status."),
});

function settleAutomationError(error: unknown): never {
  if (error instanceof AutomationVersionConflictError)
    throw conflict(error.message, { version: error.currentVersion });
  if (error instanceof AutomationServiceError || error instanceof AutomationExecuteError) {
    const status = /not found/i.test(error.message)
      ? 404
      : /requires the .* permission/i.test(error.message)
        ? 403
        : 422;
    if (status === 404) throw notFound("automation");
    if (status === 403) throw new ApplicationError("forbidden", error.message, status);
    throw invalidInput(error.message);
  }
  throw error;
}

async function requirePermission(context: ApplicationContext, permission: string): Promise<void> {
  assertApplicationPermission(context, permission);
  if (!(await isFeatureEnabled(context.authz.user.orgId, "automations"))) throw notFound("route");
}

export const ADMIN_AUTOMATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_automation",
    title: "Create Automation",
    description:
      "Create a disabled automation draft from a trigger, rules, conditions and actions. Use automations_status to review recipes and obtain ids before editing or running them.",
    inputSchema: createBody.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "automations.manage"),
    featureKey: "automations",
    execute: async (context, input) => {
      await requirePermission(context, "automations.manage");
      try {
        const automation = await createAutomation({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          name: input.name,
          description: input.description,
          trigger: input.trigger,
          rules: input.rules,
          conditions: input.conditions,
          actions: input.actions,
          ...(input.priority != null ? { priority: input.priority } : {}),
        });
        return {
          ok: true,
          automation,
          automationId: automation.id,
          status: automation.status,
          href: "/admin/automations",
        };
      } catch (error) {
        settleAutomationError(error);
      }
    },
  }),
  definition({
    name: "update_automation",
    title: "Update Automation",
    description:
      "Edit an automation using its current version from automations_status; every accepted edit advances the version and preserves prior run history.",
    inputSchema: z
      .object({ automationId: UUID, ...updateFields.shape, idempotencyKey: IDEMPOTENCY_KEY })
      .refine(
        (body) =>
          Object.keys(body).some(
            (key) => !["automationId", "idempotencyKey", "expectedVersion"].includes(key),
          ),
        {
          message: "provide at least one automation field to update",
        },
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "automations.manage"),
    featureKey: "automations",
    execute: async (context, input) => {
      await requirePermission(context, "automations.manage");
      try {
        const automation = await updateAutomation({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          automationId: input.automationId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
          ...(input.rules !== undefined ? { rules: input.rules } : {}),
          ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
          ...(input.actions !== undefined ? { actions: input.actions } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          expectedVersion: input.expectedVersion,
        });
        return {
          ok: true,
          automation,
          automationId: automation.id,
          status: automation.status,
          href: "/admin/automations",
        };
      } catch (error) {
        settleAutomationError(error);
      }
    },
  }),
  definition({
    name: "set_automation_status",
    title: "Enable or Disable Automation",
    description:
      "Enable or disable a saved automation. Enabling revalidates its trigger and actions; use automations_status to find the automation id and current state.",
    inputSchema: z.object({
      automationId: UUID,
      status: z.enum(["enabled", "disabled"]).describe("Desired automation status."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "automations.manage"),
    featureKey: "automations",
    execute: async (context, input) => {
      await requirePermission(context, "automations.manage");
      try {
        const automation = await setAutomationStatus({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          automationId: input.automationId,
          status: input.status,
        });
        return {
          ok: true,
          automation,
          automationId: automation.id,
          status: automation.status,
          href: "/admin/automations",
        };
      } catch (error) {
        settleAutomationError(error);
      }
    },
  }),
  definition({
    name: "run_automation",
    title: "Run Automation",
    description:
      "Fire one enabled automation now, optionally against a subject id. Use automations_status to find the recipe and its run history; actions may send notifications or call configured integrations.",
    inputSchema: z
      .object({
        automationId: UUID,
        subjectEntity: z
          .string()
          .min(1)
          .max(100)
          .nullish()
          .describe("Subject entity key; provide together with subjectId."),
        subjectId: UUID.nullish().describe(
          "Subject record id; provide together with subjectEntity.",
        ),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((body) => (body.subjectEntity == null) === (body.subjectId == null), {
        message: "subjectEntity and subjectId travel together — pass both or neither",
      }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "automations.run"),
    featureKey: "automations",
    execute: async (context, input) => {
      await requirePermission(context, "automations.run");
      try {
        const fingerprint = `manual:${context.authz.user.id}:${input.idempotencyKey}`;
        const run = await executeAutomation({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          automationId: input.automationId,
          ...(input.subjectEntity
            ? { subjectEntity: input.subjectEntity, subjectId: input.subjectId ?? null }
            : {}),
          triggerPayload: { kind: "manual" },
          fingerprint,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, run, runId: run.runId, status: run.status, href: "/admin/automations" };
      } catch (error) {
        settleAutomationError(error);
      }
    },
  }),
  definition({
    name: "simulate_automation",
    title: "Simulate Automation",
    description:
      "Evaluate an automation without writing run or business records. Use automations_status for its id; an optional subject requires both entity and record id.",
    inputSchema: z
      .object({
        automationId: UUID,
        subjectEntity: z
          .string()
          .min(1)
          .max(100)
          .nullish()
          .describe("Subject entity key; pair with subjectId."),
        subjectId: UUID.nullish().describe("Subject record id; pair with subjectEntity."),
        sampleSize: z
          .number()
          .int()
          .min(1)
          .max(20)
          .nullish()
          .describe("Number of recent records to sample when subjectId is omitted."),
      })
      .refine((body) => body.subjectId == null || body.subjectEntity != null, {
        message:
          "subjectEntity and subjectId travel together — pass both, or pass only an entity to sample",
      }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "automations.read"),
    featureKey: "automationSimulator",
    execute: async (context, input) => {
      await requirePermission(context, "automations.read");
      if (!(await isFeatureEnabled(context.authz.user.orgId, "automations")))
        throw notFound("automation");
      if (!(await isFeatureEnabled(context.authz.user.orgId, "automationSimulator")))
        throw notFound("automation");
      try {
        const simulations = await simulateAutomation({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          automationId: input.automationId,
          ...(input.subjectEntity ? { subjectEntity: input.subjectEntity } : {}),
          ...(input.subjectId ? { subjectId: input.subjectId } : {}),
          ...(input.sampleSize != null ? { sampleSize: input.sampleSize } : {}),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { simulations, href: "/admin/automations" };
      } catch (error) {
        settleAutomationError(error);
      }
    },
  }),
];
