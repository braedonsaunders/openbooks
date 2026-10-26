import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import {
  connectorUrlRefusal,
  guardedFetch,
  type AddressLookup,
} from "../../app/api/platform/connections/_connector-guard";
import {
  defaultModel,
  isOrgControlledAiEndpoint,
  providerSpec,
  validateAiBaseUrl,
  type AiProvider,
  type ModelTier,
} from "@openbooks/engine/platform/ai-providers";

/**
 * Config-driven AI client.
 * Provider + API key + models (+ base URL) are passed in per call — resolved
 * from the org's encrypted settings (see ./ai-config.ts), NOT read from the
 * environment. Requests use a bounded fetch — and operator-supplied
 * endpoints additionally resolve DNS at save time and pin every request to
 * a verified public address (see validateAiBaseUrlLive / guardedAiFetch):
 * a name that answers private/loopback/link-local never receives the key.
 */

// Tool-heavy financial runs can leave a large evidence packet for the final
// synthesis request. Keep the per-request ceiling below the background run's
// five-minute cap, while allowing slower tenant-selected reasoning models to
// finish that final response.
const AI_REQUEST_TIMEOUT_MS = 240_000;

export type { AiProvider, ModelTier, ProviderSpec } from "@openbooks/engine/platform/ai-providers";
export {
  AI_PROVIDER_SPECS,
  defaultModel,
  isAiProvider,
  providerSpec,
  validateAiBaseUrl,
} from "@openbooks/engine/platform/ai-providers";

export type AiConfig = {
  provider: AiProvider;
  apiKey: string;
  modelFast?: string | null;
  modelSmart?: string | null;
  /**
   * Endpoint for OpenAI-compatible providers. Required for `custom`; for the
   * named compatible providers it is an optional override of the built-in URL.
   */
  baseUrl?: string | null;
  /** Org identity for prompt grounding (real name instead of a placeholder). */
  org?: { name: string } | null;
};

/**
 * Live validation of a persisted AI endpoint override: the shape check
 * above, plus DNS resolution requiring every answer to be public unicast.
 * A hostname that resolves to RFC1918/loopback/link-local (or fails to
 * resolve) is refused before the org's API key ever travels there. The
 * shared connector guard does the resolving — one guard, not two.
 */
export async function validateAiBaseUrlLive(
  provider: AiProvider,
  rawBaseUrl: string | null | undefined,
  lookupAddresses?: AddressLookup,
): Promise<string | null> {
  const canonical = validateAiBaseUrl(provider, rawBaseUrl);
  if (!canonical) return null;
  const refusal = await connectorUrlRefusal(canonical, lookupAddresses);
  if (refusal) {
    throw new Error("The AI base URL must point at a public host.");
  }
  return canonical;
}

/** True when the effective endpoint is operator-supplied (custom provider
 *  or a base-URL override): responses and errors from it are untrusted. */
export function isOrgControlledEndpoint(config: AiConfig | null | undefined): boolean {
  if (!config) return true;
  return isOrgControlledAiEndpoint(config.provider, config.baseUrl);
}

/**
 * Operator-facing failure text. Errors from operator-supplied endpoints
 * (and their SDK wrappers) can embed the endpoint's raw response body, so
 * they are replaced with a generic remedy naming what to check; built-in
 * provider errors keep their message for diagnosis.
 */
export function sanitizeAiError(config: AiConfig | null | undefined, error: unknown): string {
  if (isOrgControlledEndpoint(config)) {
    return "Request failed — check the base URL, model id and API key.";
  }
  return error instanceof Error ? error.message.slice(0, 180) : "Request failed.";
}

/**
 * Bounded fetch for org-configured OpenAI-compatible endpoints. Refuses
 * redirects: these requests bear provider API keys, which must never cross an
 * HTTP redirect boundary to a host the Location names.
 */
export const boundedAiFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const timeout = AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  return fetch(new Request(request, { signal, redirect: "error" }));
};

/**
 * Bounded fetch for operator-supplied endpoints: the same timeout and
 * redirect refusal as above, but every request additionally re-resolves
 * the host, requires public unicast, and pins the socket to a checked
 * address — a saved base URL that later rebinds to an internal address
 * fails closed instead of receiving the org's API key.
 */
export const guardedAiFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const timeout = AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  return guardedFetch(new Request(request, { signal }));
};

export function isAiConfigured(config: AiConfig | null | undefined): config is AiConfig {
  if (!config || !config.apiKey) return false;
  const spec = providerSpec(config.provider);
  if (!spec) return false;
  if (spec.requiresBaseUrl && !config.baseUrl?.trim()) return false;
  return true;
}

/** Resolve a language model from the org's config, or null when not configured. */
export function getModel(
  config: AiConfig | null | undefined,
  tier: ModelTier = "fast",
): LanguageModel | null {
  if (!isAiConfigured(config)) return null;
  const spec = providerSpec(config.provider);
  const modelId =
    (tier === "smart" ? config.modelSmart : config.modelFast) ||
    defaultModel(config.provider, tier);
  // `custom` has no default model — without an explicit one, AI stays disabled.
  if (!modelId) return null;

  switch (spec.kind) {
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey: config.apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.apiKey })(modelId);
    case "openai-compatible": {
      const baseURL = config.baseUrl?.trim() || spec.baseUrl;
      if (!baseURL) return null;
      return createOpenAICompatible({
        name: spec.value,
        apiKey: config.apiKey,
        baseURL,
        fetch: isOrgControlledEndpoint(config) ? guardedAiFetch : boundedAiFetch,
      })(modelId);
    }
  }
}

export class AIDisabledError extends Error {
  override readonly name = "AIDisabledError";
  constructor() {
    super("AI is not configured. Set a provider + API key under Administration → AI.");
  }
}

/** Live test of a config — sends a tiny prompt and reports success/failure. */
export async function pingModel(
  config: AiConfig | null | undefined,
): Promise<{ ok: boolean; message: string }> {
  const model = getModel(config, "fast");
  if (!model) {
    return {
      ok: false,
      message: "Not configured yet — check the provider, API key, model and base URL.",
    };
  }
  try {
    const { text } = await generateText({ model, prompt: "Reply with the single word: ok" });
    return { ok: true, message: `Connected — the model replied “${text.trim().slice(0, 24)}”.` };
  } catch (e) {
    return { ok: false, message: sanitizeAiError(config, e) };
  }
}
