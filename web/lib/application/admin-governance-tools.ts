import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isDocumentRevisionToken } from "@openbooks/engine/records/revision";
import { AiRailsError } from "@openbooks/engine/hrm/ai/errors";
import {
  createCustomFieldDefinition,
  updateCustomFieldDefinition,
} from "@openbooks/engine/records/custom-field-admin";
import {
  listCapabilities,
  syncCapabilitiesForOrg,
  updateCapabilityForOrg,
} from "@openbooks/engine/hrm/ai/governance";
import { CONTINUOUS_CLOSE_AGENT_KEYS } from "@openbooks/engine/continuous-close/continuous-close";
import { CONTINUOUS_CLOSE_DETECTOR_SPECS } from "@openbooks/engine/agents/continuous-close-config";
import { db } from "@openbooks/engine/platform/db";
import { isAiProvider, pingModel, type AiProvider } from "../assistant/client";
import { classifyModelsError } from "../assistant/models-error";
import { listModelsCached } from "../assistant/models";
import {
  getOrgAiConfig,
  getOrgAiSettings,
  saveOrgAiAgentSettings,
  saveOrgAiSettings,
  type AiSettingsInput,
} from "../assistant/ai-config";
import { isCustomFieldTargetEnabled } from "../customization/gates";
import { testDocumentCaptureAction } from "@/app/api/admin/ai/document-capture/test/route";
import { normalizeCustomFieldConfig } from "../custom-field-config";
import { validateCustomFieldDefinition } from "../custom-field-definition";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID returned by the relevant administration read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

async function assertAiGovernanceEnabled(context: ApplicationContext): Promise<void> {
  assertApplicationPermission(context, "admin.setup.manage");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "aiGovernanceLedger")))
    throw notFound("route");
}

const customConfig = z
  .record(z.string(), z.json())
  .superRefine((config, ctx) => {
    for (const key of ["min", "max"]) {
      if (typeof config[key] === "number")
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must be an exact decimal string`,
        });
    }
  })
  .describe("Field configuration; numeric bounds are exact decimal strings.");
const customFieldType = z.enum([
  "text",
  "long_text",
  "number",
  "currency",
  "date",
  "boolean",
  "select",
  "multi_select",
  "reference",
]);

const DETECTOR_KEYS = [
  ...new Set(CONTINUOUS_CLOSE_DETECTOR_SPECS.map((spec) => spec.detectorKey)),
] as [string, ...string[]];
const AGENT_KEYS = [...CONTINUOUS_CLOSE_AGENT_KEYS] as [string, ...string[]];
const aiProvider = z.enum([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "groq",
  "xai",
  "deepseek",
  "mistral",
  "custom",
]);

function assertUnrestricted(context: ApplicationContext, permission: string): void {
  assertApplicationPermission(context, permission);
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function settleAiRailsError(error: unknown): never {
  if (!(error instanceof AiRailsError)) throw error;
  const status =
    error.code === "ai_invalid_input" || error.code === "ai_reason_required"
      ? 400
      : error.code === "ai_forbidden" || error.code === "ai_autonomy_raise_refused"
        ? 403
        : error.code === "ai_subject_missing" ||
            error.code === "ai_flag_missing" ||
            error.code === "ai_capability_missing" ||
            error.code === "ai_decision_missing" ||
            error.code === "ai_feature_off" ||
            error.code === "ai_unknown_capability" ||
            error.code === "ai_unknown_draft_kind"
          ? 404
          : error.code === "ai_finalize_blocked" || error.code === "ai_flag_closed"
            ? 409
            : 422;
  if (status === 403)
    throw new ApplicationError("forbidden", error.message, status, { code: error.code });
  if (status === 404)
    throw new ApplicationError("not_found", error.message, status, { code: error.code });
  if (status === 409) throw conflict(error.message, { code: error.code });
  throw new ApplicationError("invalid_input", error.message, status, { code: error.code });
}

function requireCustomTarget(orgId: string, table: string, kind: string | null | undefined) {
  return isCustomFieldTargetEnabled(orgId, table, kind ?? null);
}

function settleCustomFieldResult(result: {
  kind: string;
  error?: string;
  id?: string;
  updatedAt?: string;
}): never | void {
  switch (result.kind) {
    case "duplicate":
      throw conflict("a field with that key already exists on that target");
    case "missing":
    case "target_disabled":
      throw notFound("custom field");
    case "revision_conflict":
      throw conflict("The field definition has changed. Reload it before saving.");
    case "invalid":
      throw new ApplicationError(
        "invalid_input",
        result.error ?? "invalid custom field definition",
        400,
      );
  }
}

const agentPolicyBody = z.object({
  agentKey: z.enum(AGENT_KEYS).describe("Continuous Close agent key."),
  enabled: z.boolean().describe("Whether this agent may run."),
  automaticRuns: z.boolean().describe("Whether scheduled runs are enabled."),
  cadence: z.enum(["daily", "weekly"]).describe("Schedule cadence."),
  materialityThreshold: z.string().max(32).describe("Exact decimal materiality threshold."),
  detectors: z
    .array(
      z.object({
        detectorKey: z.enum(DETECTOR_KEYS).describe("Registered detector key."),
        enabled: z.boolean().describe("Whether this detector is enabled."),
        materialityThreshold: z
          .string()
          .max(32)
          .nullable()
          .describe("Exact decimal override, or null for the agent default."),
        parameters: z
          .record(z.string(), z.number())
          .describe("Detector parameters from its registered policy."),
      }),
    )
    .max(100)
    .describe("Detector controls for this agent."),
  analysis: z
    .object({
      rootCauseAnalysis: z.boolean().describe("Include root cause analysis."),
      recommendations: z.boolean().describe("Include recommendations."),
      narrative: z.boolean().describe("Include a narrative summary."),
      modelTier: z.enum(["fast", "smart"]).describe("Configured AI model tier."),
      maxToolSteps: z.number().int().min(4).max(30).describe("Maximum agent tool steps."),
    })
    .describe("Analysis controls."),
  notification: z
    .object({
      mode: z.enum(["findings_only", "digest", "immediate"]).describe("Notification mode."),
      roleIds: z.array(UUID).max(100).describe("Reviewer role ids."),
      userIds: z.array(UUID).max(100).describe("Reviewer user ids."),
    })
    .nullable()
    .optional()
    .describe("Notification recipients, or null to clear them."),
});

export const ADMIN_CUSTOM_FIELD_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_custom_fields",
    title: "List Custom Fields",
    description:
      "List custom field definitions on enabled record targets. Use the returned field id and updatedAt revision to edit a definition; disabled target modules stay hidden until re-enabled.",
    inputSchema: z.object({
      targetTable: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Optional supported target table key filter."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.custom_fields.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.custom_fields.manage");
      const rows = await db.execute<Record<string, unknown>>(
        sql`
        select id, target_table, target_kind, key, label, field_type, config, is_required,
               is_active, sort_order, ${documentRevisionSql(sql`updated_at`)} as "updatedAt"
          from custom_field_defs
         where org_id = ${context.authz.user.orgId}
           ${input.targetTable ? sql`and target_table = ${input.targetTable}` : sql``}
         order by target_table, target_kind nulls first, sort_order, label
      `,
        "objects",
      );
      const fields = [];
      for (const row of rows) {
        if (
          await isCustomFieldTargetEnabled(
            context.authz.user.orgId,
            String(row.target_table),
            row.target_kind == null ? null : String(row.target_kind),
          )
        )
          fields.push(row);
      }
      return { fields, href: "/admin/custom-fields" };
    },
  }),
  definition({
    name: "get_custom_field_definition",
    title: "Get Custom Field Definition",
    description:
      "Read one custom field definition, including its current update revision. Use list_custom_fields to find the id; a field on a disabled target is not exposed.",
    inputSchema: z.object({ id: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.custom_fields.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.custom_fields.manage");
      const rows = await db.execute<Record<string, unknown>>(
        sql`
        select id, target_table, target_kind, key, label, field_type, config, is_required,
               is_active, sort_order, ${documentRevisionSql(sql`updated_at`)} as "updatedAt"
          from custom_field_defs where org_id = ${context.authz.user.orgId} and id = ${input.id}
      `,
        "objects",
      );
      const field = rows[0];
      if (
        !field ||
        !(await isCustomFieldTargetEnabled(
          context.authz.user.orgId,
          String(field.target_table),
          field.target_kind == null ? null : String(field.target_kind),
        ))
      )
        throw notFound("custom field");
      return { field, href: "/admin/custom-fields" };
    },
  }),
  definition({
    name: "create_custom_field",
    title: "Create Custom Field",
    description:
      "Add a field definition to a supported record or transaction target. The target module must be enabled; use list_custom_fields to verify the saved definition.",
    inputSchema: z
      .object({
        targetTable: z.string().min(1).max(100).describe("Supported target table key."),
        targetKind: z
          .string()
          .max(100)
          .nullable()
          .optional()
          .describe("Document or record kind when the table has multiple targets."),
        key: z.string().trim().min(1).max(64).describe("Stable field key used by record data."),
        label: z.string().trim().min(1).max(200).describe("Operator-facing field label."),
        fieldType: customFieldType.describe("Custom field data type."),
        config: customConfig.optional(),
        isRequired: z.boolean().optional().describe("Whether the field is required."),
        sortOrder: z.number().int().optional().describe("Position among fields on the target."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .strict(),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.custom_fields.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.custom_fields.manage");
      const err = validateCustomFieldDefinition(input);
      if (err) throw new ApplicationError("invalid_input", err, 400);
      if (
        !(await requireCustomTarget(context.authz.user.orgId, input.targetTable, input.targetKind))
      )
        throw notFound("custom field target");
      const result = await createCustomFieldDefinition({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        requestId: context.requestId,
        input: { ...input, config: normalizeCustomFieldConfig(input.config) },
      });
      settleCustomFieldResult(result);
      return {
        ok: true,
        fieldId: result.id,
        updatedAt: result.updatedAt,
        href: "/admin/custom-fields",
      };
    },
  }),
  definition({
    name: "update_custom_field",
    title: "Update Custom Field",
    description:
      "Update a custom field's label, type configuration, required state, order or active state using the exact updatedAt revision from its read. Target table, kind and key are immutable.",
    inputSchema: z.object({
      id: UUID,
      expectedUpdatedAt: z
        .string()
        .max(64)
        .refine(isDocumentRevisionToken, "copy the exact updatedAt revision from the read")
        .describe("Exact field revision from the custom field read."),
      targetTable: z
        .string()
        .max(100)
        .optional()
        .describe("Existing target table, repeated unchanged from the current definition."),
      targetKind: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("Existing target kind, repeated unchanged from the current definition."),
      key: z.string().max(64).optional().describe("Existing immutable field key."),
      label: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Replacement operator-facing field label."),
      fieldType: customFieldType.optional().describe("Replacement field data type."),
      config: customConfig.optional(),
      isActive: z.boolean().optional().describe("Whether forms accept and show this field."),
      isRequired: z.boolean().optional().describe("Whether the field is required."),
      sortOrder: z.number().int().optional().describe("Position among fields on the target."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.custom_fields.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.custom_fields.manage");
      const { id, expectedUpdatedAt, idempotencyKey: _key, ...body } = input;
      if (
        body.label === undefined &&
        body.fieldType === undefined &&
        body.config === undefined &&
        body.isActive === undefined &&
        body.isRequired === undefined &&
        body.sortOrder === undefined
      )
        throw invalidInput("provide a field value to update");
      const result = await updateCustomFieldDefinition({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        requestId: context.requestId,
        id,
        expectedUpdatedAt,
        body,
        isTargetEnabled: requireCustomTarget,
        validate: validateCustomFieldDefinition,
        normalizeConfig: normalizeCustomFieldConfig,
      });
      settleCustomFieldResult(result);
      return { ok: true, fieldId: id, updatedAt: result.updatedAt, href: "/admin/custom-fields" };
    },
  }),
];

export const ADMIN_AI_GOVERNANCE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_ai_capabilities",
    title: "List AI Capabilities",
    description:
      "Read the organization AI capability ledger, including its effective feature status and review stamps. Use the capability key returned here with update_ai_capability.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "aiGovernanceLedger",
    execute: async (context) => {
      await assertAiGovernanceEnabled(context);
      try {
        return {
          capabilities: await listCapabilities(db, context.authz.user.orgId),
          href: "/admin/setup/ai-capabilities",
        };
      } catch (error) {
        settleAiRailsError(error);
      }
    },
  }),
  definition({
    name: "update_ai_capability",
    title: "Update AI Capability Governance",
    description:
      "Lower a capability's autonomy, change its reviewer role or record a completed review. Autonomy can only be lowered from the registered maximum; use list_ai_capabilities to read its key and state.",
    inputSchema: z
      .object({
        key: z
          .string()
          .min(1)
          .max(100)
          .describe("Registered capability key from list_ai_capabilities."),
        autonomy: z
          .enum(["read_only", "draft", "propose", "act_with_confirmation"])
          .optional()
          .describe("New autonomy level; raises above the registered maximum are refused."),
        reviewerRole: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe("Reviewer role key, or null to clear it."),
        markReviewed: z
          .boolean()
          .optional()
          .describe("Record that the capability review was completed."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          input.autonomy !== undefined ||
          input.reviewerRole !== undefined ||
          input.markReviewed !== undefined,
        "provide a governance change",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "aiGovernanceLedger",
    execute: async (context, input) => {
      await assertAiGovernanceEnabled(context);
      try {
        const capability = await updateCapabilityForOrg({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          key: input.key,
          autonomy: input.autonomy,
          reviewerRole: input.reviewerRole,
          markReviewed: input.markReviewed,
        });
        return { ok: true, capability, href: "/admin/setup/ai-capabilities" };
      } catch (error) {
        settleAiRailsError(error);
      }
    },
  }),
  definition({
    name: "sync_ai_capabilities",
    title: "Synchronize AI Capability Registry",
    description:
      "Add any missing registered AI capability rows without changing existing autonomy or review state. Use list_ai_capabilities to verify the ledger after synchronization.",
    inputSchema: z.object({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "aiGovernanceLedger",
    execute: async (context) => {
      await assertAiGovernanceEnabled(context);
      try {
        const seeded = await syncCapabilitiesForOrg({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
        });
        return { ok: true, seeded, href: "/admin/setup/ai-capabilities" };
      } catch (error) {
        settleAiRailsError(error);
      }
    },
  }),
];

export const ADMIN_AI_SETTINGS_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_ai_settings",
    title: "Get AI Settings",
    description:
      "Read organization AI provider, model, capability and document-capture settings. Credential material is never returned; reads show only whether a key is configured.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.ai.manage"),
    execute: async (context) => {
      assertApplicationPermission(context, "admin.ai.manage");
      assertUnrestricted(context, "admin.ai.manage");
      return { settings: await getOrgAiSettings(context.authz.user.orgId), href: "/admin/ai" };
    },
  }),
  definition({
    name: "update_ai_settings",
    title: "Update AI Settings",
    description:
      "Save the organization AI provider and model settings plus document-capture policy while retaining saved credentials. Configure or replace provider credentials in the browser; use get_ai_settings to verify configuration without exposing secrets.",
    inputSchema: z.object({
      enabled: z.boolean().describe("Whether AI capabilities are enabled for this organization."),
      provider: aiProvider.describe("Configured AI provider."),
      modelFast: z.string().max(200).describe("Fast model identifier."),
      modelSmart: z.string().max(200).describe("Smart model identifier."),
      baseUrl: z.string().max(2000).describe("Provider base URL, if required."),
      documentCapture: z
        .object({
          enabled: z.boolean().describe("Whether document capture is enabled."),
          provider: z
            .enum(["azure_document_intelligence", "llm_vision"])
            .describe("Document capture provider."),
          endpoint: z.string().max(2000).describe("Azure document endpoint, when selected."),
          model: z.string().max(200).describe("Document capture model identifier."),
          confidenceThreshold: z
            .string()
            .max(32)
            .describe("Exact decimal threshold between zero and one."),
          autoCreatePoMatchedDrafts: z
            .boolean()
            .describe("Whether matching purchase orders may create draft bills."),
        })
        .describe("Document-capture configuration."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.ai.manage"),
    execute: async (context, input) => {
      assertUnrestricted(context, "admin.ai.manage");
      const value: AiSettingsInput = {
        ...input,
        agents: [],
      };
      try {
        await saveOrgAiSettings(context.authz.user.orgId, context.authz.user.id, value);
        return {
          ok: true,
          settings: await getOrgAiSettings(context.authz.user.orgId),
          href: "/admin/ai",
        };
      } catch (error) {
        if (error instanceof Error && error.message === "feature_disabled")
          throw conflict("Continuous Close must be enabled before activating its AI agents.");
        throw error;
      }
    },
  }),
  definition({
    name: "update_ai_agent_policy",
    title: "Update AI Agent Policy",
    description:
      "Save one Continuous Close agent's schedule, detectors, analysis and reviewer policy without changing provider credentials. Use get_ai_settings to read current policy before editing.",
    inputSchema: agentPolicyBody.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.ai.manage"),
    execute: async (context, input) => {
      assertUnrestricted(context, "admin.ai.manage");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const policy = await saveOrgAiAgentSettings(
          context.authz.user.orgId,
          context.authz.user.id,
          body,
        );
        return { ok: true, policy, href: "/admin/ai" };
      } catch (error) {
        if (error instanceof Error && error.message === "feature_disabled")
          throw conflict("Continuous Close must be enabled before activating its AI agents.");
        throw error;
      }
    },
  }),
  definition({
    name: "test_ai_provider",
    title: "Test AI Provider",
    description:
      "Send a small test prompt to the configured or supplied provider to check connectivity. A supplied key and model are used only for this test and are not saved.",
    inputSchema: z
      .object({
        provider: aiProvider
          .optional()
          .describe("Provider to test; defaults to the saved provider."),
        baseUrl: z.string().max(2000).optional().describe("Temporary provider URL for this test."),
        apiKey: z
          .string()
          .max(4000)
          .optional()
          .describe("Temporary provider credential for this test."),
        modelFast: z.string().max(200).optional().describe("Temporary fast model identifier."),
      })
      .refine((body) => Object.keys(body).length > 0, "provide a test configuration"),
    readOnly: true,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.ai.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.ai.manage");
      const saved = await getOrgAiConfig(context.authz.user.orgId);
      const provider: AiProvider = isAiProvider(input.provider)
        ? input.provider
        : (saved?.provider ?? "anthropic");
      const sameProvider = saved?.provider === provider;
      return pingModel({
        provider,
        apiKey: input.apiKey?.trim() || (sameProvider ? (saved?.apiKey ?? "") : ""),
        baseUrl: input.baseUrl?.trim() || (sameProvider ? (saved?.baseUrl ?? null) : null),
        modelFast: input.modelFast?.trim() || (sameProvider ? (saved?.modelFast ?? null) : null),
      });
    },
  }),
  definition({
    name: "list_ai_provider_models",
    title: "List AI Provider Models",
    description:
      "Read models exposed by a provider for configuration. The test uses a supplied credential or the saved credential for the same provider; no credential is returned.",
    inputSchema: z
      .object({
        provider: aiProvider
          .optional()
          .describe("Provider to inspect; defaults to the saved provider."),
        baseUrl: z.string().max(2000).optional().describe("Provider base URL override."),
        apiKey: z
          .string()
          .max(4000)
          .optional()
          .describe("Credential override used only for this request."),
        refresh: z.boolean().optional().describe("Refresh the provider model cache."),
      })
      .refine((body) => Object.keys(body).length > 0, "provide a provider configuration"),
    readOnly: true,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.ai.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.ai.manage");
      const saved = await getOrgAiConfig(context.authz.user.orgId);
      const provider: AiProvider = isAiProvider(input.provider)
        ? input.provider
        : (saved?.provider ?? "anthropic");
      let apiKey = input.apiKey?.trim() ?? "";
      let baseUrl = input.baseUrl?.trim() ?? "";
      if (!apiKey && saved?.provider === provider) {
        apiKey = saved.apiKey;
        if (!baseUrl) baseUrl = saved.baseUrl ?? "";
      }
      if (!apiKey) return { ok: false, models: [], code: "missingKey" };
      try {
        const models = await listModelsCached(
          { provider, apiKey, baseUrl: baseUrl || null },
          input.refresh === true,
        );
        return models.length ? { ok: true, models } : { ok: false, models: [], code: "empty" };
      } catch (error) {
        return { ok: false, models: [], ...classifyModelsError(error) };
      }
    },
  }),
  definition({
    name: "test_document_capture_provider",
    title: "Test Document Capture Provider",
    description:
      "Test temporary or saved document-capture provider settings without saving them. Use this when configuring invoice capture; the result reports connectivity without returning credentials.",
    inputSchema: z
      .object({
        provider: z
          .enum(["azure_document_intelligence", "llm_vision"])
          .optional()
          .describe("Document extraction provider to test."),
        aiProvider: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .optional()
          .describe("Temporary AI provider for vision-based extraction."),
        aiApiKey: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe("Temporary AI provider credential, used only for this test."),
        aiBaseUrl: z.string().max(2000).optional().describe("Temporary AI provider base URL."),
        aiModelSmart: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe("Temporary smart model identifier."),
        apiKey: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe("Temporary Azure document service credential."),
        endpoint: z.string().max(2000).optional().describe("Azure document service endpoint."),
        model: z.string().trim().min(1).max(200).optional().describe("Document model identifier."),
      })
      .refine(
        (body) => Object.keys(body).length > 0,
        "provide a document capture test configuration",
      ),
    readOnly: true,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.ai.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.ai.manage");
      const response = await testDocumentCaptureAction({ body: input, authz: context.authz });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw invalidInput(String(result.error ?? "Document provider test failed"), result);
      }
      const result = (await response.json()) as Record<string, unknown>;
      return { ...result, href: "/admin/ai" };
    },
  }),
];
