import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SuiteQL REST client — Token-Based Auth (OAuth 1.0a HMAC-SHA256).
 * Credentials are passed in (from a tenant's `connections` row), never read
 * from a global file at call time. `netsuiteCredsFromEnvFile()` bootstraps the
 * original dev connection from a gitignored .env.netsuite.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface NetSuiteCreds {
  /** Account id, e.g. "8638714" (used in the OAuth realm). */
  account: string;
  /** REST host, e.g. https://<acct>.suitetalk.api.netsuite.com */
  host: string;
  consumerKey: string;
  consumerSecret: string;
  tokenKey: string;
  tokenSecret: string;
}

/** Read the original dev connection's creds from .env.netsuite, or null. */
export function netsuiteCredsFromEnvFile(): NetSuiteCreds | null {
  const path = join(repoRoot, ".env.netsuite");
  if (!existsSync(path)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.NETSUITE_CONSUMER_KEY || !env.NETSUITE_TOKEN_KEY) return null;
  return {
    account: env.NETSUITE_ACCOUNT,
    host: env.NETSUITE_HOST,
    consumerKey: env.NETSUITE_CONSUMER_KEY,
    consumerSecret: env.NETSUITE_CONSUMER_SECRET,
    tokenKey: env.NETSUITE_TOKEN_KEY,
    tokenSecret: env.NETSUITE_TOKEN_SECRET,
  };
}

const pct = (s: string | number) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(creds: NetSuiteCreds, method: string, url: string, query: Record<string, string | number>): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_token: creds.tokenKey,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_version: "1.0",
  };
  const all: Record<string, string | number> = { ...query, ...oauth };
  const paramStr = Object.entries(all)
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramStr)].join("&");
  const key = `${pct(creds.consumerSecret)}&${pct(creds.tokenSecret)}`;
  const sig = createHmac("sha256", key).update(base).digest("base64");
  oauth.oauth_signature = sig;
  return (
    `OAuth realm="${creds.account}", ` +
    Object.entries(oauth)
      .sort()
      .map(([k, v]) => `${k}="${pct(v)}"`)
      .join(", ")
  );
}

export async function suiteql<T = Record<string, unknown>>(
  query: string,
  creds: NetSuiteCreds,
  limit = 1000,
): Promise<T[]> {
  const url = `${creds.host}/services/rest/query/v1/suiteql`;
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const qp = { limit, offset };
    const res = await fetch(`${url}?limit=${limit}&offset=${offset}`, {
      method: "POST",
      headers: {
        Authorization: oauthHeader(creds, "POST", url, qp),
        "Content-Type": "application/json",
        Prefer: "transient",
      },
      body: JSON.stringify({ q: query }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SuiteQL HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as { items: (T & { links?: unknown })[]; hasMore: boolean };
    for (const item of data.items) {
      delete (item as { links?: unknown }).links;
      rows.push(item);
    }
    if (!data.hasMore) return rows;
    offset += limit;
  }
}
