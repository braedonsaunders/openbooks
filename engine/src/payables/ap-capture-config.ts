import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { unsealSecret } from "../platform/secrets.ts";
import {
  defaultModel,
  isAiProvider,
  isOrgControlledAiEndpoint,
  providerSpec,
  validateAiBaseUrl,
  type AiProvider,
} from "../platform/ai-providers.ts";
import { resolveVerifiedAddresses } from "../connectors/ssrf-guard.ts";
import {
  DEFAULT_INVOICE_MODEL,
  DocumentEndpointError,
  verifyAzureDocumentEndpoint,
  type AddressLookup,
} from "./ap-capture.ts";
import { LLM_VISION_API_VERSIONS, type LlmVisionConfig } from "./document-capture-llm.ts";
import { AZURE_DOCUMENT_INTELLIGENCE_API_VERSION } from "./document-capture-azure.ts";

/**
 * Document capture configuration (Platform → AI → Document capture): which
 * provider reads bills and receipts, the confidence a reading needs before it
 * fills a draft field, and the provider's credentials.
 *
 * - `azure_document_intelligence`: the organization's Azure endpoint and key,
 *   sealed with the capture purpose.
 * - `llm_vision`: the organization's AI model provider (the provider, key and
 *   base URL configured for the assistant), with an optional model chosen
 *   for document capture; without one the provider's smart model reads.
 */

export const DOCUMENT_CAPTURE_PROVIDERS = ["azure_document_intelligence", "llm_vision"] as const;
export type DocumentCaptureProvider = (typeof DOCUMENT_CAPTURE_PROVIDERS)[number];

export function isDocumentCaptureProvider(value: unknown): value is DocumentCaptureProvider {
  return (
    typeof value === "string" && (DOCUMENT_CAPTURE_PROVIDERS as readonly string[]).includes(value)
  );
}

export type DocumentCaptureSettings = {
  enabled: boolean;
  provider: DocumentCaptureProvider;
  endpoint: string;
  /** Azure: the invoice model. AI model provider: the capture model, blank for the provider's smart model. */
  model: string;
  confidenceThreshold: string;
  autoCreatePoMatchedDrafts: boolean;
  /** Azure: a sealed capture key exists. */
  hasKey: boolean;
};

type CaptureCommon = {
  enabled: boolean;
  confidenceThreshold: string;
  autoCreatePoMatchedDrafts: boolean;
};

export type DocumentCaptureRuntimeConfig =
  | (CaptureCommon & {
      provider: "azure_document_intelligence";
      endpoint: string;
      model: string;
      apiKey: string;
      apiVersion: string;
    })
  | (CaptureCommon & {
      provider: "llm_vision";
      model: string;
      llm: LlmVisionConfig;
      apiVersion: string;
    });

export type StoredDocumentCapture = {
  enabled?: boolean;
  provider?: string;
  endpoint?: string;
  model?: string;
  confidenceThreshold?: string;
  autoCreatePoMatchedDrafts?: boolean;
  keyEncrypted?: string;
};

type StoredAi = {
  enabled?: boolean;
  provider?: string;
  modelSmart?: string;
  baseUrl?: string;
  keyEncrypted?: string;
  documentCapture?: StoredDocumentCapture;
};

function normalizeThreshold(value: unknown): string {
  const raw = String(value ?? "0.9000").trim();
  if (!/^0(?:\.\d{1,4})?$|^1(?:\.0{1,4})?$/.test(raw)) return "0.9000";
  const [whole, fraction = ""] = raw.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}

export function normalizeStoredDocumentCapture(raw: unknown): DocumentCaptureSettings {
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as StoredDocumentCapture) : {};
  const provider: DocumentCaptureProvider =
    row.provider === "llm_vision" ? "llm_vision" : "azure_document_intelligence";
  const model = typeof row.model === "string" ? row.model.trim() : "";
  return {
    enabled: row.enabled === true,
    provider,
    endpoint: typeof row.endpoint === "string" ? row.endpoint : "",
    model: provider === "azure_document_intelligence" ? model || DEFAULT_INVOICE_MODEL : model,
    confidenceThreshold: normalizeThreshold(row.confidenceThreshold),
    autoCreatePoMatchedDrafts: row.autoCreatePoMatchedDrafts === true,
    hasKey: Boolean(row.keyEncrypted),
  };
}

async function readStored(
  orgId: string,
): Promise<{ globalEnabled: boolean; ai: StoredAi; capture: StoredDocumentCapture }> {
  const result = await db.execute<{ ai: Record<string, unknown> | null }>(
    sql`
    select settings->'ai' as ai from orgs where id = ${orgId}
  `,
    "objects",
  );
  const ai = (result[0]?.ai ?? {}) as StoredAi;
  const capture = ai.documentCapture;
  return {
    globalEnabled: ai.enabled !== false,
    ai,
    capture:
      capture && typeof capture === "object" && !Array.isArray(capture)
        ? (capture as StoredDocumentCapture)
        : {},
  };
}

/** The AI provider and model document capture reads with, before its key is unsealed. */
function llmTarget(
  ai: StoredAi,
  captureModel: string,
): { provider: AiProvider; model: string; baseUrl: string | null } | null {
  if (!isAiProvider(ai.provider) || !ai.keyEncrypted) return null;
  return llmTargetFor(ai.provider, ai.modelSmart, ai.baseUrl, captureModel);
}

/** The reading target for one provider: a vision-capable provider, its endpoint and the model that reads. */
function llmTargetFor(
  provider: AiProvider,
  modelSmart: string | undefined,
  baseUrl: string | undefined,
  captureModel: string,
): { provider: AiProvider; model: string; baseUrl: string | null } | null {
  const model = captureModel || modelSmart?.trim() || defaultModel(provider, "smart");
  if (!model) return null;
  const spec = providerSpec(provider);
  if (spec.vision.length === 0) return null;
  const endpoint = spec.kind === "openai-compatible" ? baseUrl?.trim() || spec.baseUrl : null;
  if (spec.kind === "openai-compatible" && !endpoint) return null;
  return { provider, model, baseUrl: endpoint };
}

/** Re-verify an organization-configured AI endpoint before its key travels there. */
async function verifyLlmEndpoint(
  target: { provider: AiProvider; baseUrl: string | null },
  overridden: boolean,
  lookup?: AddressLookup,
): Promise<void> {
  if (!overridden || !target.baseUrl) return;
  let endpoint: URL;
  try {
    endpoint = new URL(validateAiBaseUrl(target.provider, target.baseUrl) ?? target.baseUrl);
  } catch (error) {
    throw new DocumentEndpointError(
      `The AI base URL is not usable for document capture — ${error instanceof Error ? error.message : "check it under Platform → AI"}`,
      { cause: error },
    );
  }
  try {
    await resolveVerifiedAddresses(endpoint, lookup);
  } catch (error) {
    throw new DocumentEndpointError(
      `The AI base URL ${endpoint.hostname} did not resolve to a public address — check it under Platform → AI`,
      { cause: error },
    );
  }
}

/** The Azure endpoint, model and key an administrator is testing, from the form or the stored settings. */
export async function getDocumentCaptureTestConfig(
  orgId: string,
  override: { endpoint?: string; model?: string; apiKey?: string },
): Promise<{ endpoint: string; model: string; apiKey: string } | null> {
  const { capture } = await readStored(orgId);
  const settings = normalizeStoredDocumentCapture(capture);
  const endpoint = override.endpoint?.trim() || settings.endpoint;
  const model =
    override.model?.trim() ||
    (settings.provider === "azure_document_intelligence" ? settings.model : DEFAULT_INVOICE_MODEL);
  const apiKey =
    override.apiKey?.trim() ||
    (capture.keyEncrypted == null
      ? ""
      : unsealSecret(capture.keyEncrypted, { orgId, purpose: "payables.ap-capture.key" })) ||
    "";
  if (!endpoint || !apiKey) return null;
  return { endpoint, model, apiKey };
}

/**
 * The AI model configuration an administrator is testing for document
 * capture, or null without a usable provider. The form's provider, key, base
 * URL and models apply as typed, before they are saved; a field left blank
 * falls back to the stored setting only for the stored provider, so a key
 * saved for one provider never travels to another. A typed base URL passes
 * the same validation and public-address check as a saved one.
 */
export async function getLlmCaptureTestConfig(
  orgId: string,
  override: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    modelSmart?: string;
    model?: string;
  },
  lookup?: AddressLookup,
): Promise<LlmVisionConfig | null> {
  const { ai, capture } = await readStored(orgId);
  const settings = normalizeStoredDocumentCapture(capture);
  const provider = isAiProvider(override.provider)
    ? override.provider
    : isAiProvider(ai.provider)
      ? ai.provider
      : null;
  if (!provider) return null;
  const sameProvider = provider === ai.provider;
  const typedKey = override.apiKey?.trim() ?? "";
  const apiKey =
    typedKey ||
    (sameProvider && ai.keyEncrypted
      ? (unsealSecret(ai.keyEncrypted, { orgId, purpose: "assistant.ai.key" }) ?? "")
      : "");
  if (!apiKey) return null;
  const typedBaseUrl = override.baseUrl === undefined ? undefined : override.baseUrl.trim();
  const storedBaseUrl = sameProvider ? ai.baseUrl?.trim() || "" : "";
  const target = llmTargetFor(
    provider,
    override.modelSmart?.trim() || (sameProvider ? ai.modelSmart : undefined),
    typedBaseUrl ?? storedBaseUrl,
    override.model?.trim() ||
      (settings.provider === "llm_vision" && sameProvider ? settings.model : ""),
  );
  if (!target) return null;
  await verifyLlmEndpoint(
    target,
    isOrgControlledAiEndpoint(target.provider, typedBaseUrl ?? storedBaseUrl),
    lookup,
  );
  return { ...target, apiKey };
}

export async function getDocumentCaptureSettings(orgId: string): Promise<DocumentCaptureSettings> {
  const { capture } = await readStored(orgId);
  return normalizeStoredDocumentCapture(capture);
}

/**
 * Whether document capture can run for the organization: AI enabled, capture
 * enabled, and the chosen provider configured (Azure: an endpoint and a
 * sealed key; AI model: a provider with vision models, its key and a model).
 * Reads configuration only; endpoints are verified when a capture runs.
 */
export async function documentCaptureOperational(orgId: string): Promise<boolean> {
  const { globalEnabled, ai, capture } = await readStored(orgId);
  const settings = normalizeStoredDocumentCapture(capture);
  if (!globalEnabled || !settings.enabled) return false;
  if (settings.provider === "llm_vision") return llmTarget(ai, settings.model) !== null;
  return Boolean(settings.endpoint) && settings.hasKey;
}

/** The worker's only config resolver. Disabled/missing/tampered secrets fail closed. */
export async function getDocumentCaptureRuntimeConfig(
  orgId: string,
  lookup?: AddressLookup,
): Promise<DocumentCaptureRuntimeConfig | null> {
  const { globalEnabled, ai, capture } = await readStored(orgId);
  const settings = normalizeStoredDocumentCapture(capture);
  if (!globalEnabled || !settings.enabled) return null;
  const common = {
    enabled: settings.enabled,
    confidenceThreshold: settings.confidenceThreshold,
    autoCreatePoMatchedDrafts: settings.autoCreatePoMatchedDrafts,
  };
  if (settings.provider === "llm_vision") {
    const target = llmTarget(ai, settings.model);
    if (!target) return null;
    await verifyLlmEndpoint(target, isOrgControlledAiEndpoint(target.provider, ai.baseUrl), lookup);
    const apiKey = unsealSecret(ai.keyEncrypted!, { orgId, purpose: "assistant.ai.key" });
    if (!apiKey) return null;
    return {
      ...common,
      provider: "llm_vision",
      model: target.model,
      llm: { ...target, apiKey },
      apiVersion: LLM_VISION_API_VERSIONS[providerSpec(target.provider).kind],
    };
  }
  if (!settings.endpoint) return null;
  await verifyAzureDocumentEndpoint(settings.endpoint, lookup);
  const apiKey =
    capture.keyEncrypted == null
      ? null
      : unsealSecret(capture.keyEncrypted, { orgId, purpose: "payables.ap-capture.key" });
  if (!apiKey) return null;
  return {
    ...common,
    provider: "azure_document_intelligence",
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey,
    apiVersion: AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
  };
}
