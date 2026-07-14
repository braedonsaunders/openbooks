import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SuiteQL REST client — Token-Based Auth (OAuth 1.0a HMAC-SHA256).
 * TypeScript port of extraction/suiteql.py; creds from gitignored
 * .env.netsuite at the repo root.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadNsEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(repoRoot, ".env.netsuite"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const pct = (s: string | number) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(env: Record<string, string>, method: string, url: string, query: Record<string, string | number>): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: env.NETSUITE_CONSUMER_KEY,
    oauth_token: env.NETSUITE_TOKEN_KEY,
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
  const key = `${pct(env.NETSUITE_CONSUMER_SECRET)}&${pct(env.NETSUITE_TOKEN_SECRET)}`;
  const sig = createHmac("sha256", key).update(base).digest("base64");
  oauth.oauth_signature = sig;
  return (
    `OAuth realm="${env.NETSUITE_ACCOUNT}", ` +
    Object.entries(oauth)
      .sort()
      .map(([k, v]) => `${k}="${pct(v)}"`)
      .join(", ")
  );
}

export async function suiteql<T = Record<string, unknown>>(query: string, limit = 1000): Promise<T[]> {
  const env = loadNsEnv();
  const url = `${env.NETSUITE_HOST}/services/rest/query/v1/suiteql`;
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const qp = { limit, offset };
    const res = await fetch(`${url}?limit=${limit}&offset=${offset}`, {
      method: "POST",
      headers: {
        Authorization: oauthHeader(env, "POST", url, qp),
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
