import { fetchWithConnectorRetry } from "./http-retry.ts";
import { guardedFetch } from "./ssrf-guard.ts";

/**
 * Recurly API v2021-02-25 client (https://recurly.com/developers/api).
 *
 * Auth is a Bearer API key on every call, so every request refuses
 * redirects instead of following them. Lists page with an opaque cursor
 * (`has_more`/`next`); `begin_time`/`end_time` bound incremental pulls on
 * `updated_at`. Money in v3 payloads is major-unit decimal text.
 */

const API_BASE = "https://v3.recurly.com";
const API_VERSION = "application/vnd.recurly.v2021-02-25";

export interface RecurlySite {
  apiKey: string;
}

export type ConnectorTransport = typeof fetch;

async function recurlyGet(
  site: RecurlySite,
  path: string,
  params: Record<string, string>,
  transport: ConnectorTransport = guardedFetch,
): Promise<{ records: Array<Record<string, unknown>>; next: string | null }> {
  const query = new URLSearchParams(params);
  const res = await fetchWithConnectorRetry(`${API_BASE}${path}?${query.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${site.apiKey}`, Accept: API_VERSION },
    redirect: "error",
  }, { describe: "Recurly", transport });
  if (!res.ok) {
    throw new Error(`Recurly ${path} refused HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const payload = (await res.json()) as { object?: string; data?: Array<Record<string, unknown>>; has_more?: boolean; next?: string };
  if (payload.object === "error" || payload.object === "validation_error") {
    throw new Error(`Recurly ${path} refused: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  const records = Array.isArray(payload.data) ? payload.data : [];
  return { records, next: payload.has_more && typeof payload.next === "string" ? payload.next : null };
}

/** One Recurly list page. `resource` is plural (`accounts`, `subscriptions`, …). */
export async function listRecurly(
  site: RecurlySite,
  resource: string,
  params: Record<string, string> = {},
  transport: ConnectorTransport = guardedFetch,
): Promise<{ records: Array<Record<string, unknown>>; next: string | null }> {
  return recurlyGet(site, `/${resource}`, { limit: "200", ...params }, transport);
}

/** Pull every page of a Recurly list, bounded so a runaway cursor cannot loop forever. */
export async function listAllRecurly(
  site: RecurlySite,
  resource: string,
  params: Record<string, string> = {},
  transport: ConnectorTransport = guardedFetch,
  maxPages = 500,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await listRecurly(site, resource, cursor ? { ...params, cursor } : params, transport);
    out.push(...result.records);
    if (!result.next) return out;
    cursor = result.next;
  }
  throw new Error(`Recurly ${resource} exceeded ${maxPages} pages — narrow the window and import incrementally.`);
}

/** A single Recurly resource by id (accounts, plans, subscriptions, invoices…). */
export async function getRecurly(
  site: RecurlySite,
  resource: string,
  id: string,
  transport: ConnectorTransport = guardedFetch,
): Promise<Record<string, unknown>> {
  const query = "";
  const res = await fetchWithConnectorRetry(`${API_BASE}/${resource}/${encodeURIComponent(id)}${query}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${site.apiKey}`, Accept: API_VERSION },
    redirect: "error",
  }, { describe: "Recurly", transport });
  if (!res.ok) {
    throw new Error(`Recurly ${resource}/${id} refused HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}
