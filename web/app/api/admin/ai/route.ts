import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { guardPermission, guardUnrestrictedScope } from "../../../../lib/authz";
import { isAiProvider, type AiProvider } from "../../../../lib/assistant/client";
import { CONTINUOUS_CLOSE_AGENT_KEYS } from "@openbooks/engine/src/continuous-close/continuous-close.ts";
import { CONTINUOUS_CLOSE_DETECTOR_SPECS } from "@openbooks/engine/src/agents/continuous-close-config.ts";
import { canonicalDecimal } from "@openbooks/engine/src/money/exact-decimal.ts";
import { moneyRefusal } from "@openbooks/engine/src/money/decimal-refusal.ts";
import {
  clearOrgAiKey,
  CONTINUOUS_CLOSE_DISABLED_REMEDY,
  getOrgAiSettings,
  saveOrgAiSettings,
  normalizeAgentSettingsInput,
  type AiSettingsInput,
} from "../../../../lib/assistant/ai-config";

const detectorKeys = [...new Set(CONTINUOUS_CLOSE_DETECTOR_SPECS.map((spec) => spec.detectorKey))] as [string, ...string[]];
const agentKeys = [...CONTINUOUS_CLOSE_AGENT_KEYS] as [string, ...string[]];
const materialityThresholdSchema = z.string().superRefine((value, ctx) => {
  if (canonicalDecimal(value, 4) === null) ctx.addIssue({ code: "custom", message: moneyRefusal("Materiality threshold", value) });
});
const partialAgentPolicySchema = z.object({
  agentKey: z.enum(agentKeys),
  enabled: z.boolean().optional(),
  automaticRuns: z.boolean().optional(),
  cadence: z.enum(["daily", "weekly"]).optional(),
  materialityThreshold: materialityThresholdSchema.optional(),
  detectors: z.array(z.object({
    detectorKey: z.enum(detectorKeys),
    enabled: z.boolean().optional(),
    materialityThreshold: materialityThresholdSchema.nullable().optional(),
    parameters: z.record(z.string(), z.number()).optional(),
  })).optional(),
  analysis: z.object({
    rootCauseAnalysis: z.boolean().optional(), recommendations: z.boolean().optional(),
    narrative: z.boolean().optional(), modelTier: z.enum(["fast", "smart"]).optional(),
    maxToolSteps: z.number().int().min(4).max(30).optional(),
  }).optional(),
  notification: z.object({
    mode: z.enum(["findings_only", "digest", "immediate"]),
    roleIds: z.array(z.string().uuid()).max(100), userIds: z.array(z.string().uuid()).max(100),
  }).nullable().optional(),
});

const requestBodySchema = z.object({
  "agents": z.array(partialAgentPolicySchema).optional(),
  "apiKey": z.string().optional(),
  "baseUrl": z.string().optional(),
  "documentCapture": z.object({
    enabled: z.boolean().optional(),
    endpoint: z.string().optional(),
    model: z.string().optional(),
    confidenceThreshold: z.string().optional(),
    autoCreatePoMatchedDrafts: z.boolean().optional(),
    apiKey: z.string().optional(),
  }).optional(),
  "enabled": z.boolean().optional(),
  "modelFast": z.string().optional(),
  "modelSmart": z.string().optional(),
  "provider": z.enum(["anthropic", "openai", "google", "openrouter", "groq", "xai", "deepseek", "mistral", "custom"]).optional(),
});


export const runtime = "nodejs";

/** Org AI settings for the admin form — never includes secret material. */
async function legacyGET() {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
}

/** Save settings; the API key is sealed at rest and only replaced when typed. */
async function legacyPUT(req: Request) {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  let body: Partial<AiSettingsInput> & { provider?: string };
  try {
    const parsedBody = await parseJsonBody(req, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data as Partial<AiSettingsInput> & { provider?: string };
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
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
      provider: "azure_document_intelligence",
      endpoint: String(body.documentCapture?.endpoint ?? "").trim(),
      model: String(body.documentCapture?.model ?? "prebuilt-invoice").trim(),
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
}

/** Remove the stored (encrypted) API key. */
async function legacyDELETE() {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  await clearOrgAiKey(gate.user.orgId, gate.user.id);
  return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
}

export const GET = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  handler: async () => legacyGET(),
});

export const PUT = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  body: requestBodySchema,
  handler: async ({ request, body }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPUT(replayRequest as never);
  },
});

export const DELETE = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  handler: async () => legacyDELETE(),
});
