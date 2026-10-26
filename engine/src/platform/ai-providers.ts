/**
 * The AI provider catalogue: one source of truth for the settings screen,
 * the assistant's model factory, document capture through the AI model and
 * configuration validation. An organization chooses one provider, its key
 * and models under Platform → AI; every AI feature reads that choice.
 */

export type AiProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "groq"
  | "xai"
  | "deepseek"
  | "mistral"
  | "custom";

export type ModelTier = "fast" | "smart";

/** How a provider's requests are shaped. OpenAI-compatible covers the named compatible providers and custom endpoints. */
export type ProviderKind = "anthropic" | "openai" | "google" | "openai-compatible";

/** Document formats a provider's models read as images or files. */
export type AiVisionContentType = "image/jpeg" | "image/png" | "application/pdf";

export type ProviderSpec = {
  value: AiProvider;
  label: string;
  kind: ProviderKind;
  /** Built-in endpoint for a named OpenAI-compatible provider (null otherwise). */
  baseUrl: string | null;
  /** True when the org MUST supply their own base URL (i.e. `custom`). */
  requiresBaseUrl: boolean;
  /** Default fast/smart model ids (placeholders + fallbacks). Empty for `custom`. */
  fast: string;
  smart: string;
  /** Placeholder shown in the API-key field. */
  keyHint: string;
  /** Optional note about the model-id format for this provider. */
  modelHint?: string;
  /**
   * Document formats the provider's API accepts as model input. Whether a
   * particular model reads images is the model's own capability; a provider
   * whose API takes no images reads no documents at all.
   */
  vision: readonly AiVisionContentType[];
};

export const AI_PROVIDER_SPECS: ProviderSpec[] = [
  {
    value: "anthropic",
    label: "Anthropic — Claude",
    kind: "anthropic",
    baseUrl: null,
    requiresBaseUrl: false,
    fast: "claude-haiku-4-5-20251001",
    smart: "claude-sonnet-4-6",
    keyHint: "sk-ant-…",
    vision: ["image/jpeg", "image/png", "application/pdf"],
  },
  {
    value: "openai",
    label: "OpenAI — GPT",
    kind: "openai",
    baseUrl: null,
    requiresBaseUrl: false,
    fast: "gpt-4o-mini",
    smart: "gpt-4o",
    keyHint: "sk-…",
    vision: ["image/jpeg", "image/png", "application/pdf"],
  },
  {
    value: "google",
    label: "Google — Gemini",
    kind: "google",
    baseUrl: null,
    requiresBaseUrl: false,
    fast: "gemini-2.5-flash",
    smart: "gemini-2.5-pro",
    keyHint: "AIza…",
    vision: ["image/jpeg", "image/png", "application/pdf"],
  },
  {
    value: "openrouter",
    label: "OpenRouter — any model, one key",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresBaseUrl: false,
    fast: "anthropic/claude-3.5-haiku",
    smart: "anthropic/claude-3.5-sonnet",
    keyHint: "sk-or-…",
    modelHint: "Use vendor/model slugs, e.g. anthropic/claude-3.5-sonnet or openai/gpt-4o.",
    vision: ["image/jpeg", "image/png"],
  },
  {
    value: "groq",
    label: "Groq — fast inference",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresBaseUrl: false,
    fast: "llama-3.1-8b-instant",
    smart: "llama-3.3-70b-versatile",
    keyHint: "gsk_…",
    vision: ["image/jpeg", "image/png"],
  },
  {
    value: "xai",
    label: "xAI — Grok",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    requiresBaseUrl: false,
    fast: "grok-2-1212",
    smart: "grok-2-vision-1212",
    keyHint: "xai-…",
    vision: ["image/jpeg", "image/png"],
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    requiresBaseUrl: false,
    fast: "deepseek-chat",
    smart: "deepseek-chat",
    keyHint: "sk-…",
    vision: [],
  },
  {
    value: "mistral",
    label: "Mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    requiresBaseUrl: false,
    fast: "mistral-small-latest",
    smart: "mistral-large-latest",
    keyHint: "Your Mistral API key",
    vision: ["image/jpeg", "image/png"],
  },
  {
    value: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai-compatible",
    baseUrl: null,
    requiresBaseUrl: true,
    fast: "",
    smart: "",
    keyHint: "Your provider API key",
    modelHint:
      "Use a public HTTPS OpenAI-compatible endpoint (for example Together, Fireworks, Perplexity, or hosted vLLM) and set explicit model ids.",
    vision: ["image/jpeg", "image/png"],
  },
];

const SPEC_BY_VALUE = Object.fromEntries(AI_PROVIDER_SPECS.map((s) => [s.value, s])) as Record<
  AiProvider,
  ProviderSpec
>;

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && Object.hasOwn(SPEC_BY_VALUE, value);
}

export function providerSpec(provider: AiProvider): ProviderSpec {
  return SPEC_BY_VALUE[provider];
}

export function defaultModel(provider: AiProvider, tier: ModelTier): string {
  const spec = SPEC_BY_VALUE[provider] ?? SPEC_BY_VALUE.anthropic;
  return tier === "smart" ? spec.smart : spec.fast;
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;

/** Validate and canonicalize a persisted AI endpoint override. */
export function validateAiBaseUrl(
  provider: AiProvider,
  rawBaseUrl: string | null | undefined,
): string | null {
  const spec = providerSpec(provider);
  const raw = rawBaseUrl?.trim() ?? "";
  if (spec.kind !== "openai-compatible") {
    if (raw) throw new Error(`${spec.label} does not support a custom base URL.`);
    return null;
  }
  if (!raw) {
    if (spec.requiresBaseUrl) throw new Error("A public HTTPS base URL is required.");
    return null;
  }

  let submitted: URL;
  try {
    submitted = new URL(raw);
  } catch {
    throw new Error("The AI base URL is not valid.");
  }
  if (submitted.protocol !== "https:") {
    throw new Error("The AI base URL must use HTTPS.");
  }
  if (submitted.search || submitted.hash) {
    throw new Error("The AI base URL must not include a query string or fragment.");
  }
  if (submitted.username || submitted.password) {
    throw new Error("The AI base URL must not include credentials.");
  }
  if (PRIVATE_HOST_RE.test(submitted.hostname)) {
    throw new Error("The AI base URL must point at a public host.");
  }

  const path = withoutTrailingSlashes(submitted.pathname);
  submitted.pathname = path || "/";
  const canonical = withoutTrailingSlashes(submitted.href);
  return canonical || submitted.origin;
}

/** True when the effective endpoint is operator-supplied (custom provider or a base-URL override): its responses are untrusted. */
export function isOrgControlledAiEndpoint(
  provider: AiProvider,
  baseUrl: string | null | undefined,
): boolean {
  const spec = SPEC_BY_VALUE[provider];
  if (!spec) return true;
  if (spec.kind !== "openai-compatible") return false;
  return spec.requiresBaseUrl || Boolean(baseUrl?.trim());
}
