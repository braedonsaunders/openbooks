import { fetchWithConnectorRetry } from "./http-retry.ts";
import { guardedFetch } from "./ssrf-guard.ts";

/**
 * Maxio Advanced Billing client (the Chargify API,
 * https://maxio.zendesk.com/hc/en-us/categories/360000047453).
 *
 * Auth is the site API key as the Basic username on every call, so every
 * request refuses redirects instead of following them. Lists page with
 * `page`/`per_page`; most lists accept `date_field=updated_at` with
 * `start_date`/`end_date` bounds for incremental pulls. Money is integer
 * minor units (`*_in_cents` fields) of the site's currency.
 */

export interface MaxioSite {
  /** Merchant subdomain, e.g. `acme` for `acme.chargify.com`. */
  subdomain: string;
  apiKey: string;
}

export type ConnectorTransport = typeof fetch;

function siteBase(site: MaxioSite): string {
  const name = site.subdomain.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i.test(name)) {
    throw new Error("Maxio subdomain is invalid — enter the subdomain before .chargify.com.");
  }
  return `https://${name}.chargify.com`;
}

function authHeader(site: MaxioSite): string {
  return "Basic " + Buffer.from(`${site.apiKey}:x`).toString("base64");
}

async function maxioGet(
  site: MaxioSite,
  path: string,
  params: Record<string, string>,
  transport: ConnectorTransport = guardedFetch,
): Promise<unknown> {
  const query = new URLSearchParams(params);
  const suffix = query.toString();
  const res = await fetchWithConnectorRetry(`${siteBase(site)}${path}${suffix ? `?${suffix}` : ""}`, {
    method: "GET",
    headers: { Authorization: authHeader(site), Accept: "application/json" },
    redirect: "error",
  }, { describe: "Maxio", transport });
  if (!res.ok) {
    throw new Error(`Maxio ${path} refused HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json();
}

/** Pull every page of a Maxio list, bounded so a runaway page count cannot loop forever. */
export async function listAllMaxio<T>(
  site: MaxioSite,
  path: string,
  params: Record<string, string> = {},
  transport: ConnectorTransport = guardedFetch,
  maxPages = 500,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const payload = await maxioGet(site, path, { ...params, page: String(page), per_page: "200" }, transport);
    if (!Array.isArray(payload)) {
      throw new Error(`Maxio ${path} answered a non-list payload — re-enter the subdomain and API key, then try again.`);
    }
    if (!payload.length) return out;
    // Chargify wraps most resources (`{ subscription: {...} }`); pass wrapped
    // rows through untouched — the adapter unwraps them.
    out.push(...(payload as T[]));
    if (payload.length < 200) return out;
  }
  throw new Error(`Maxio ${path} exceeded ${maxPages} pages — narrow the window and import incrementally.`);
}

/** Incremental bounds every dated Maxio list accepts. */
export function maxioUpdatedBounds(updatedAfter?: string): Record<string, string> {
  if (!updatedAfter) return {};
  return { date_field: "updated_at", start_date: updatedAfter.slice(0, 10), direction: "asc" };
}
