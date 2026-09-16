import "server-only";
import { providerSpec, validateAiBaseUrl, type AiConfig } from "./client";

/**
 * Model discovery queries each provider's "list models" endpoint so the settings UI can offer dynamic
 * dropdowns instead of free-text model ids. Runs server-side only (the API key
 * never leaves the server).
 */

export type ModelListItem = { id: string; label?: string };

function trimSlash(u: string): string {
  let end = u.length;
  while (end > 0 && u.charCodeAt(end - 1) === 47) end -= 1;
  return u.slice(0, end);
}

function dedupeSort(items: ModelListItem[]): ModelListItem[] {
  const map = new Map<string, ModelListItem>();
  for (const it of items) {
    if (it.id && !map.has(it.id)) map.set(it.id, it);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  // Provider keys ride Authorization headers or a ?key= query parameter; a
  // followed redirect would replay them to whichever host the Location names.
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 160)}` : ""}`);
  }
  return res.json();
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * OpenAI returns every model (embeddings, tts, image…). Drop the families that
 * can never chat; everything else is offered as-is so a new model family the
 * provider ships tomorrow appears without a code change. The list is
 * discovered from the provider — never a hardcoded allowlist of names.
 */
function isOpenAiChatModel(id: string): boolean {
  return !/embedding|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|similarity|babbage|davinci/i.test(
    id,
  );
}

/**
 * Provider model lists change rarely and the settings UI asks for them on
 * every dropdown open. Cache per provider + base URL + key fingerprint for a
 * short TTL; a failed fetch is never cached. The key itself is not stored —
 * only a SHA-256 fingerprint keys the entry.
 */
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const modelListCache = new Map<string, { at: number; items: ModelListItem[] }>();

async function cacheKeyFor(config: AiConfig): Promise<string> {
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256").update(config.apiKey ?? "").digest("hex").slice(0, 32);
  return `${config.provider}|${config.baseUrl ?? ""}|${fingerprint}`;
}

/** Cached wrapper around `listModels`; `force` bypasses the cache. */
export async function listModelsCached(config: AiConfig, force = false): Promise<ModelListItem[]> {
  const key = await cacheKeyFor(config);
  const hit = modelListCache.get(key);
  if (!force && hit && Date.now() - hit.at < MODEL_LIST_TTL_MS) return hit.items;
  const items = await listModels(config);
  modelListCache.set(key, { at: Date.now(), items });
  return items;
}

/**
 * Fetch the available model ids for a provider config. Throws on HTTP / auth
 * errors so the caller can surface the provider's message.
 */
export async function listModels(config: AiConfig): Promise<ModelListItem[]> {
  const spec = providerSpec(config.provider);
  const key = config.apiKey;

  switch (spec.kind) {
    case "anthropic": {
      const json = await fetchJson("https://api.anthropic.com/v1/models?limit=1000", {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      });
      const data = asArray((json as Record<string, unknown>)?.data);
      return dedupeSort(
        data.map((m) => ({
          id: str(m.id),
          label: m.display_name ? str(m.display_name) : undefined,
        })),
      );
    }
    case "openai": {
      const json = await fetchJson("https://api.openai.com/v1/models", {
        Authorization: `Bearer ${key}`,
      });
      const data = asArray((json as Record<string, unknown>)?.data);
      return dedupeSort(
        data.map((m) => ({ id: str(m.id) })).filter((m) => isOpenAiChatModel(m.id)),
      );
    }
    case "google": {
      const json = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`,
        {},
      );
      const models = asArray((json as Record<string, unknown>)?.models);
      return dedupeSort(
        models
          .filter((m) => {
            const methods = m.supportedGenerationMethods;
            return Array.isArray(methods) && methods.includes("generateContent");
          })
          .map((m) => ({
            id: str(m.name).replace(/^models\//, ""),
            label: m.displayName ? str(m.displayName) : undefined,
          })),
      );
    }
    case "openai-compatible": {
      const baseURL = validateAiBaseUrl(config.provider, config.baseUrl) || spec.baseUrl;
      if (!baseURL) throw new Error("A base URL is required to list models.");
      const json = await fetchJson(`${trimSlash(baseURL)}/models`, {
        Authorization: `Bearer ${key}`,
      });
      const root = json as Record<string, unknown>;
      const data = asArray(root?.data).length ? asArray(root?.data) : asArray(root?.models);
      return dedupeSort(
        data.map((m) => {
          const id = str(m.id || m.name);
          const name = str(m.name);
          return { id, label: name && name !== id ? name : undefined };
        }),
      );
    }
  }
}
