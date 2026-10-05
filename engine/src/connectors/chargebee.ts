import { fetchWithConnectorRetry } from "./http-retry.ts";
import { guardedFetch } from "./ssrf-guard.ts";

/**
 * Chargebee API v2 client (https://apidocs.chargebee.com/docs/api).
 *
 * Auth is an API key carried as the Basic username on every call, so every
 * request refuses redirects instead of following them. List endpoints page
 * with `limit`/`offset`; `updated_at[after]` bounds incremental pulls.
 * Amounts in v2 payloads are integer minor units of the object's currency.
 */

export interface ChargebeeSite {
  /** Merchant site name, e.g. `acme` for `acme.chargebee.com`. */
  site: string;
  apiKey: string;
}

export type ConnectorTransport = typeof fetch;

function siteBase(site: ChargebeeSite): string {
  const name = site.site.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i.test(name)) {
    throw new Error("Chargebee site name is invalid — enter the subdomain before .chargebee.com.");
  }
  return `https://${name}.chargebee.com/api/v2`;
}

function authHeader(site: ChargebeeSite): string {
  return "Basic " + Buffer.from(`${site.apiKey}:`).toString("base64");
}

async function chargebeeGet(
  site: ChargebeeSite,
  path: string,
  params: Record<string, string>,
  transport: ConnectorTransport = guardedFetch,
): Promise<unknown> {
  const query = new URLSearchParams(params);
  const res = await fetchWithConnectorRetry(`${siteBase(site)}${path}?${query.toString()}`, {
    method: "GET",
    headers: { Authorization: authHeader(site), Accept: "application/json" },
    redirect: "error",
  }, { describe: "Chargebee", transport });
  if (!res.ok) {
    throw new Error(`Chargebee ${path} refused HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json();
}

export interface ChargebeePage<T> {
  records: T[];
  /** Offset for the next page, or null when the list is exhausted. */
  nextOffset: string | null;
}

function toPage<T>(payload: unknown, key: string): ChargebeePage<T> {
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.list) ? root.list as Array<{ [k: string]: T }> : [];
  return {
    records: list.map((entry) => entry[key] as T).filter((record) => record !== undefined),
    nextOffset: typeof root.next_offset === "string" ? root.next_offset as string : null,
  };
}

/** One Chargebee list page. `resource` is plural (`customers`, `subscriptions`, …). */
export async function listChargebee<T>(
  site: ChargebeeSite,
  resource: string,
  params: Record<string, string> = {},
  transport: ConnectorTransport = guardedFetch,
): Promise<ChargebeePage<T>> {
  return toPage<T>(await chargebeeGet(site, `/${resource}`, { limit: "100", ...params }, transport), resource.replace(/s$/, ""));
}

/** Pull every page of a Chargebee list, bounded by `maxPages` so a runaway cursor cannot loop forever. */
export async function listAllChargebee<T>(
  site: ChargebeeSite,
  resource: string,
  params: Record<string, string> = {},
  transport: ConnectorTransport = guardedFetch,
  maxPages = 500,
): Promise<T[]> {
  const out: T[] = [];
  let offset: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await listChargebee<T>(
      site,
      resource,
      offset ? { ...params, offset } : params,
      transport,
    );
    out.push(...result.records);
    if (!result.nextOffset) return out;
    offset = result.nextOffset;
  }
  throw new Error(`Chargebee ${resource} exceeded ${maxPages} pages — narrow the window and import incrementally.`);
}

/** Chargebee events carry the change history subscriptions alone cannot state (created/changed/renewed/cancelled with snapshots). */
export async function listChargebeeEvents(
  site: ChargebeeSite,
  eventTypes: string[],
  updatedAfter?: string,
  transport: ConnectorTransport = guardedFetch,
): Promise<Array<Record<string, unknown>>> {
  const params: Record<string, string> = {};
  eventTypes.forEach((type, index) => {
    params[`event_type[in][${index}]`] = type;
  });
  if (updatedAfter) params["occurred_at[after]"] = String(Math.floor(new Date(updatedAfter).getTime() / 1000));
  return listAllChargebee<Record<string, unknown>>(site, "events", params, transport);
}
