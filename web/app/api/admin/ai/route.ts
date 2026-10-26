import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";

import { NextResponse } from "next/server";
import { isAiProvider, type AiProvider } from "@/lib/assistant/client";
import { CONTINUOUS_CLOSE_AGENT_KEYS } from "@openbooks/engine/continuous-close/continuous-close";
import { CONTINUOUS_CLOSE_DETECTOR_SPECS } from "@openbooks/engine/agents/continuous-close-config";
import { canonicalDecimal } from "@openbooks/engine/money/decimal";
import { moneyRefusal } from "@openbooks/engine/money/decimal-refusal";
import {
  clearOrgAiKey,
  CONTINUOUS_CLOSE_DISABLED_REMEDY,
  getOrgAiSettings,
  saveOrgAiSettings,
  normalizeAgentSettingsInput,
  type AiSettingsInput,
} from "@/lib/assistant/ai-config";

const detectorKeys = [
  ...new Set(CONTINUOUS_CLOSE_DETECTOR_SPECS.map((spec) => spec.detectorKey)),
] as [string, ...string[]];
const agentKeys = [...CONTINUOUS_CLOSE_AGENT_KEYS] as [string, ...string[]];
const materialityThresholdSchema = z.string().superRefine((value, ctx) => {
  if (canonicalDecimal(value, 4) === null)
    ctx.addIssue({ code: "custom", message: moneyRefusal("Materiality threshold", value) });
});
const partialAgentPolicySchema = z.object({
  agentKey: z.enum(agentKeys),
  enabled: z.boolean().optional(),
  automaticRuns: z.boolean().optional(),
  cadence: z.enum(["daily", "weekly"]).optional(),
  materialityThreshold: materialityThresholdSchema.optional(),
  detectors: z
    .array(
      z.object({
        detectorKey: z.enum(detectorKeys),
        enabled: z.boolean().optional(),
        materialityThreshold: materialityThresholdSchema.nullable().optional(),
        parameters: z.record(z.string(), z.number()).optional(),
      }),
    )
    .optional(),
  analysis: z
    .object({
      rootCauseAnalysis: z.boolean().optional(),
      recommendations: z.boolean().optional(),
      narrative: z.boolean().optional(),
      modelTier: z.enum(["fast", "smart"]).optional(),
      maxToolSteps: z.number().int().min(4).max(30).optional(),
    })
    .optional(),
  notification: z
    .object({
      mode: z.enum(["findings_only", "digest", "immediate"]),
      roleIds: z.array(uuidString()).max(100),
      userIds: z.array(uuidString()).max(100),
    })
    .nullable()
    .optional(),
});

const requestBodySchema = z
  .object({
    agents: z.array(partialAgentPolicySchema).optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    documentCapture: z
      .object({
        enabled: z.boolean().optional(),
        provider: z.enum(["azure_document_intelligence", "llm_vision"]).optional(),
        endpoint: z.string().optional(),
        model: z.string().optional(),
        confidenceThreshold: z.string().optional(),
        autoCreatePoMatchedDrafts: z.boolean().optional(),
        apiKey: z.string().optional(),
      })
      .optional(),
    enabled: z.boolean().optional(),
    modelFast: z.string().optional(),
    modelSmart: z.string().optional(),
    provider: z
      .enum([
        "anthropic",
        "openai",
        "google",
        "openrouter",
        "groq",
        "xai",
        "deepseek",
        "mistral",
        "custom",
      ])
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const runtime = "nodejs";

const AI_SETTINGS_FEATURE: { none: string } = {
  none: "AI provider configuration is organization administration under the admin AI permission; enabling an agent pack is refused by name while Continuous Close is off.",
};

/** Org AI settings for the admin form — never includes secret material. */
export const GET = defineRoute({
  permission: "admin.ai.manage",
  feature: AI_SETTINGS_FEATURE,
  scope: "unrestricted",
  handler: async ({ authz }) => NextResponse.json(await getOrgAiSettings(authz.user.orgId)),
});

/** Save settings; the API key is sealed at rest and only replaced when typed. */
export const PUT = defineRoute({
  permission: "admin.ai.manage",
  feature: AI_SETTINGS_FEATURE,
  scope: "unrestricted",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const provider: AiProvider = isAiProvider(body.provider) ? body.provider : "anthropic";
    const input: AiSettingsInput = {
      enabled: body.enabled !== false,
      provider,
      modelFast: String(body.modelFast ?? "").trim(),
      modelSmart: String(body.modelSmart ?? "").trim(),
      baseUrl: String(body.baseUrl ?? "").trim(),
      apiKey: String(body.apiKey ?? "").trim() || undefined,
      agents: [],
      documentCapture: {
        enabled: body.documentCapture?.enabled === true,
        provider:
          body.documentCapture?.provider === "llm_vision"
            ? "llm_vision"
            : "azure_document_intelligence",
        endpoint: String(body.documentCapture?.endpoint ?? "").trim(),
        model: String(
          body.documentCapture?.model ??
            (body.documentCapture?.provider === "llm_vision" ? "" : "prebuilt-invoice"),
        ).trim(),
        confidenceThreshold: String(body.documentCapture?.confidenceThreshold ?? "0.9000").trim(),
        autoCreatePoMatchedDrafts: body.documentCapture?.autoCreatePoMatchedDrafts === true,
        apiKey: String(body.documentCapture?.apiKey ?? "").trim() || undefined,
      },
    };
    try {
      // Pack policies live under Setup → Agents: a provider save that omits the
      // array must leave every policy untouched — normalizing an absent array
      // would default-disable all packs (persistAgentPolicy loops input.agents).
      input.agents = body.agents === undefined ? [] : normalizeAgentSettingsInput(body.agents);
      await saveOrgAiSettings(gate.user.orgId, gate.user.id, input);
    } catch (e) {
      // Enabling a pack while Continuous Close is off refuses by name with a
      // 409 (like the run routes), carrying the remedy instead of the bare
      // code; every other validation failure stays a 422.
      if ((e as Error).message === "feature_disabled") {
        return NextResponse.json({ error: CONTINUOUS_CLOSE_DISABLED_REMEDY }, { status: 409 });
      }
      return apiErrorResponse(e);
    }
    return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
  },
});

/** Remove the stored (encrypted) API key. */
export const DELETE = defineRoute({
  permission: "admin.ai.manage",
  feature: AI_SETTINGS_FEATURE,
  scope: "unrestricted",
  handler: async ({ authz }) => {
    await clearOrgAiKey(authz.user.orgId, authz.user.id);
    return NextResponse.json(await getOrgAiSettings(authz.user.orgId));
  },
});
