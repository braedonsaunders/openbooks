import { guardedFetch, type AddressLookup } from "../connectors/ssrf-guard.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { cmp } from "../money/money.ts";
import {
  isOrgControlledAiEndpoint,
  providerSpec,
  type AiProvider,
  type AiVisionContentType,
  type ProviderKind,
} from "../platform/ai-providers.ts";
import { normalizeCapturedDecimal, type CaptureEvidence } from "./document-capture-azure.ts";

/**
 * Document capture through the organization's AI model provider (the
 * provider, key and models chosen under Platform → AI).
 *
 * The model reads one receipt or invoice image (or PDF where the provider's
 * API accepts documents) and answers a strict JSON contract: every field is
 * `{ "value": …, "confidence": 0..1 }`, values are copied exactly as printed,
 * and anything not visible is null. The answer's first balanced JSON object
 * is parsed; an answer without one, or one that breaks the contract, fails
 * the capture with a retryable reason rather than inventing fields. The
 * normalized reading then passes the same validation as any provider: a
 * field without a confident, valid reading stays blank and is flagged.
 *
 * Every request travels through the SSRF guard (pinned public DNS, no
 * redirects), so an organization-configured endpoint cannot reach an
 * internal address with the organization's key.
 */

export const LLM_VISION_PROVIDER = "llm_vision";

/** The request protocol recorded as a capture's API version. */
export const LLM_VISION_API_VERSIONS: Record<ProviderKind, string> = {
  anthropic: "anthropic-messages-2023-06-01",
  openai: "openai-chat-completions-v1",
  google: "gemini-generate-content-v1beta",
  "openai-compatible": "openai-compatible-chat-completions",
};

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 4_096;

export type LlmVisionConfig = {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** The OpenAI-compatible endpoint (a named provider's built-in URL, or the organization's override). */
  baseUrl: string | null;
};

/** A document-capture refusal that names its remedy, answered as 422. */
export class LlmCaptureError extends Error {
  readonly name = "LlmCaptureError";
  readonly status = 422;
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** The document formats the configured provider reads, or a refusal naming what it accepts. */
export function assertLlmReadable(provider: AiProvider, contentType: string): AiVisionContentType {
  const spec = providerSpec(provider);
  if (spec.vision.length === 0) {
    throw new LlmCaptureError(
      `${spec.label} cannot read document images — choose a provider with vision models under Platform → AI, or use Azure Document Intelligence`,
      "llm_vision_unsupported",
    );
  }
  if (!(spec.vision as readonly string[]).includes(contentType)) {
    const accepted = spec.vision
      .map((type) => (type === "application/pdf" ? "PDF" : type === "image/png" ? "PNG" : "JPEG"))
      .join(", ");
    throw new LlmCaptureError(
      `${spec.label} reads ${accepted} documents — save this ${contentType} file as one of those and scan it again`,
      "llm_vision_format",
    );
  }
  return contentType as AiVisionContentType;
}

function endpointFor(config: LlmVisionConfig, kind: ProviderKind): URL {
  if (kind === "anthropic") return new URL("https://api.anthropic.com/v1/messages");
  if (kind === "openai") return new URL("https://api.openai.com/v1/chat/completions");
  if (kind === "google") {
    return new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
    );
  }
  const base = config.baseUrl?.trim() || providerSpec(config.provider).baseUrl;
  if (!base)
    throw new LlmCaptureError(
      "The AI provider has no endpoint — set its base URL under Platform → AI",
      "llm_endpoint_missing",
    );
  return new URL(`${base.replace(/\/+$/, "")}/chat/completions`);
}

function requestBody(
  config: LlmVisionConfig,
  kind: ProviderKind,
  prompt: string,
  contentType: AiVisionContentType,
  data: string,
): unknown {
  if (kind === "anthropic") {
    const source = { type: "base64", media_type: contentType, data };
    return {
      model: config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            contentType === "application/pdf"
              ? { type: "document", source }
              : { type: "image", source },
            { type: "text", text: prompt },
          ],
        },
      ],
    };
  }
  if (kind === "google") {
    return {
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: contentType, data } }, { text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    };
  }
  const dataUrl = `data:${contentType};base64,${data}`;
  const attachment =
    contentType === "application/pdf"
      ? { type: "file", file: { filename: "document.pdf", file_data: dataUrl } }
      : { type: "image_url", image_url: { url: dataUrl } };
  return {
    model: config.model,
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(kind === "openai" ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, attachment] }],
  };
}

function requestHeaders(config: LlmVisionConfig, kind: ProviderKind): Record<string, string> {
  if (kind === "anthropic")
    return {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  if (kind === "google")
    return { "x-goog-api-key": config.apiKey, "content-type": "application/json" };
  return { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
}

/** The model's text answer from each provider's response shape. */
function responseText(kind: ProviderKind, body: unknown): string | null {
  const value = body as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (kind === "anthropic") {
    const content = Array.isArray(value.content) ? value.content : [];
    const text = content
      .filter((part) => (part as { type?: unknown }).type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join("");
    return text || null;
  }
  if (kind === "google") {
    const candidate = Array.isArray(value.candidates)
      ? (value.candidates[0] as { content?: { parts?: Array<{ text?: unknown }> } })
      : undefined;
    const text = (candidate?.content?.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return text || null;
  }
  const choice = Array.isArray(value.choices)
    ? (value.choices[0] as { message?: { content?: unknown } })
    : undefined;
  const content = choice?.message?.content;
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
    return text || null;
  }
  return null;
}

async function providerFailure(config: LlmVisionConfig, response: Response): Promise<string> {
  // An organization-configured endpoint's body is untrusted and never echoed;
  // a built-in provider's structured message names the fault.
  if (isOrgControlledAiEndpoint(config.provider, config.baseUrl))
    return `HTTP ${response.status} — check the base URL, model id and API key under Platform → AI`;
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const message =
      typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // The body was not JSON; the status names the failure.
  }
  return `HTTP ${response.status}`;
}

/** Send one document and an instruction to the configured model; returns the model's text answer. */
export async function requestLlmVision(input: {
  config: LlmVisionConfig;
  prompt: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<string> {
  const { config } = input;
  if (!config.apiKey.trim())
    throw new LlmCaptureError(
      "The AI provider's API key is missing — add it under Platform → AI",
      "llm_key_missing",
    );
  if (!config.model.trim())
    throw new LlmCaptureError(
      "No AI model is set for document capture — choose one under Platform → AI",
      "llm_model_missing",
    );
  const contentType = assertLlmReadable(config.provider, input.contentType);
  const kind = providerSpec(config.provider).kind;
  const url = endpointFor(config, kind);
  const runFetch: typeof fetch =
    input.fetchImpl ??
    ((target, init) => guardedFetch(target, init ?? {}, { lookup: input.lookup }));
  const response = await runFetch(url, {
    method: "POST",
    headers: requestHeaders(config, kind),
    body: JSON.stringify(
      requestBody(
        config,
        kind,
        input.prompt,
        contentType,
        Buffer.from(input.bytes).toString("base64"),
      ),
    ),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `The AI provider could not read the document: ${await providerFailure(config, response)}`,
    );
  const body = await response.json().catch(() => null);
  const text = responseText(kind, body);
  if (!text)
    throw new Error("The AI provider returned no answer for the document — retry the scan");
  return text;
}

/**
 * The first balanced JSON object in a model's answer, or null. Code fences
 * and prose around the object are ignored; braces inside strings do not
 * count toward the balance.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(trimmed.slice(start, index + 1));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** A field the model answered: the value it copied and its stated confidence. */
export type LlmField = { value: string | null; confidence: string | null; raw: string | null };

/**
 * Read one contract field. Strings are trimmed; a number is kept only when
 * its text is an exact short decimal (a long float could have lost digits on
 * the way into JSON). Confidence is bounded to 0..1 with four places; a
 * missing or out-of-range confidence is null, which reads as below every
 * threshold.
 */
export function readLlmField(raw: unknown): LlmField {
  const field =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { value: raw };
  const value = field.value;
  let text: string | null = null;
  if (typeof value === "string") text = value.trim() || null;
  else if (typeof value === "number" && Number.isFinite(value)) {
    const printed = String(value);
    text = /^-?\d{1,15}(\.\d{1,4})?$/.test(printed) ? printed : null;
  }
  const confidence =
    typeof field.confidence === "number" &&
    Number.isFinite(field.confidence) &&
    field.confidence >= 0 &&
    field.confidence <= 1
      ? field.confidence.toFixed(4)
      : null;
  return { value: text, confidence, raw: text };
}

/** A money reading: canonical when the text is one unambiguous decimal, else the supplied text for review. */
export function llmMoney(field: LlmField): { canonical: string | null; supplied: string | null } {
  if (field.value === null) return { canonical: null, supplied: null };
  const canonical = normalizeCapturedDecimal(field.value);
  return canonical === null
    ? { canonical: null, supplied: field.value }
    : { canonical, supplied: null };
}

/** Evidence for one answered field; a model gives no page geometry. */
export function llmEvidence(
  fieldKey: string,
  field: LlmField,
  normalizedValue: unknown,
  lineIndex: number | null = null,
): CaptureEvidence {
  return {
    fieldKey,
    lineIndex,
    rawValue: field.raw,
    normalizedValue,
    confidence: field.confidence,
    pageNumber: null,
    polygon: null,
  };
}

/** The document's overall confidence: the weakest of its identifying fields, or null when one is unread. */
export function llmOverallConfidence(fields: readonly LlmField[]): string | null {
  let weakest: string | null = null;
  for (const field of fields) {
    if (field.value === null || field.confidence === null) return null;
    if (weakest === null || cmp(field.confidence, weakest) < 0) weakest = field.confidence;
  }
  return weakest;
}

/** A typed calendar date only; anything else rides as printed text. */
export function llmDate(field: LlmField): { date: string | null; text: string | null } {
  if (field.value === null) return { date: null, text: null };
  return isIsoCalendarDate(field.value)
    ? { date: field.value, text: null }
    : { date: null, text: field.value };
}

/** Live check of the AI provider for document capture: a tiny image and a JSON answer. */
export async function testLlmDocumentProvider(input: {
  config: LlmVisionConfig;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<{ ok: boolean; message: string }> {
  try {
    // A 1×1 white PNG: enough to prove the model accepts an image.
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    const text = await requestLlmVision({
      config: input.config,
      prompt: 'Reply with only this JSON object: {"ok": true}',
      contentType: "image/png",
      bytes: pixel,
      fetchImpl: input.fetchImpl,
      lookup: input.lookup,
    });
    const answer = extractJsonObject(text);
    if (answer?.ok !== true)
      return {
        ok: false,
        message:
          "The model answered, but not with the JSON document capture needs — choose a vision model",
      };
    return { ok: true, message: "Connected — the model reads document images" };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? redactKey(error.message, input.config.apiKey).slice(0, 180)
          : "Connection failed",
    };
  }
}

/** A provider message never carries the key it was sent, whole or in part. */
function redactKey(message: string, apiKey: string): string {
  const key = apiKey.trim();
  if (key.length < 8) return message;
  let redacted = message.split(key).join("[key]");
  // Providers echo a key's prefix or suffix ("sk-…abcd"); remove any run of
  // eight or more of its characters.
  for (let length = Math.min(key.length - 1, 40); length >= 8; length -= 1) {
    for (let start = 0; start + length <= key.length; start += 1) {
      const piece = key.slice(start, start + length);
      if (redacted.includes(piece)) redacted = redacted.split(piece).join("[key]");
    }
  }
  return redacted;
}
