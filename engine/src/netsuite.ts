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
  /** Account id, e.g. "1234567" (used in the OAuth realm). */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One SuiteQL page with a hard timeout + retry. A bare fetch has NO timeout —
 * a stalled connection hangs a migration forever (observed live: 65 minutes
 * dead in the water on a dropped socket). 60s abort per attempt, 4 attempts
 * with backoff on 429/5xx/network errors; the OAuth header is regenerated per
 * attempt (fresh nonce/timestamp).
 */
async function suiteqlPage(
  creds: NetSuiteCreds,
  url: string,
  query: string,
  limit: number,
  offset: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const qp = { limit, offset };
      const res = await fetch(`${url}?limit=${limit}&offset=${offset}`, {
        method: "POST",
        headers: {
          Authorization: oauthHeader(creds, "POST", url, qp),
          "Content-Type": "application/json",
          Prefer: "transient",
        },
        body: JSON.stringify({ q: query }),
        signal: ctl.signal,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        lastErr = new Error(`SuiteQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : attempt * 2000);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await sleep(attempt * 2000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("SuiteQL failed after retries");
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
    const res = await suiteqlPage(creds, url, query, limit, offset);
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

/** Invoke a tenant-authenticated RESTlet with the same TBA credentials as SuiteQL. */
export async function netsuiteRestlet<T = unknown>(
  script: string | number,
  deploy: string | number,
  params: Record<string, unknown>,
  creds: NetSuiteCreds,
  method: "GET" | "POST" = "GET",
): Promise<T> {
  const accountHost = creds.account.replaceAll("_", "-").toLowerCase();
  const endpoint = `https://${accountHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl`;
  const query: Record<string, string | number> = { script, deploy };
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`RESTlet GET parameter ${key} must be a string or number`);
      }
      query[key] = value;
    }
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) search.set(key, String(value));

  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120_000);
    try {
      const response = await fetch(`${endpoint}?${search.toString()}`, {
        method,
        headers: {
          Authorization: oauthHeader(creds, method, endpoint, query),
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(params) } : {}),
        signal: ctl.signal,
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        lastError = new Error(`RESTlet HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        await sleep(retryAfter > 0 ? retryAfter * 1_000 : attempt * 2_000);
        continue;
      }
      if (!response.ok) {
        throw new Error(`RESTlet HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(attempt * 2_000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RESTlet failed after retries");
}

/** Read a paginated native-record collection through SuiteTalk REST. */
export async function netsuiteRecords<T = Record<string, unknown>>(
  recordType: string,
  creds: NetSuiteCreds,
  limit = 1000,
): Promise<T[]> {
  const endpoint = `${creds.host}/services/rest/record/v1/${encodeURIComponent(recordType)}`;
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const query = { limit, offset };
    const res = await fetch(`${endpoint}?limit=${limit}&offset=${offset}`, {
      headers: { Authorization: oauthHeader(creds, "GET", endpoint, query), Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`SuiteTalk ${recordType} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = await res.json() as { items?: T[]; hasMore?: boolean };
    rows.push(...(data.items ?? []));
    if (!data.hasMore) return rows;
    offset += limit;
  }
}

/** Read one native SuiteTalk REST record, expanding referenced subresources. */
export async function netsuiteRecord<T = Record<string, unknown>>(
  recordType: string,
  id: string | number,
  creds: NetSuiteCreds,
): Promise<T> {
  const endpoint = `${creds.host}/services/rest/record/v1/${encodeURIComponent(recordType)}/${encodeURIComponent(String(id))}`;
  const query = { expandSubResources: "true" };
  const res = await fetch(`${endpoint}?expandSubResources=true`, {
    headers: { Authorization: oauthHeader(creds, "GET", endpoint, query), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SuiteTalk ${recordType}/${id} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json() as T;
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function soapTokenPassport(
  creds: NetSuiteCreds,
  endpointVersion: string,
): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatureBase = [
    creds.account,
    creds.consumerKey,
    creds.tokenKey,
    nonce,
    timestamp,
  ].join("&");
  const signatureKey = `${creds.consumerSecret}&${creds.tokenSecret}`;
  const signature = createHmac("sha256", signatureKey)
    .update(signatureBase)
    .digest("base64");
  return `<tokenPassport xmlns="urn:messages_${endpointVersion}.platform.webservices.netsuite.com">
      <account>${xmlAttribute(creds.account)}</account>
      <consumerKey>${xmlAttribute(creds.consumerKey)}</consumerKey>
      <token>${xmlAttribute(creds.tokenKey)}</token>
      <nonce>${nonce}</nonce>
      <timestamp>${timestamp}</timestamp>
      <signature algorithm="HMAC-SHA256">${signature}</signature>
    </tokenPassport>`;
}

async function netsuiteSoapRequest(
  action: string,
  body: string,
  creds: NetSuiteCreds,
  endpointVersion: string,
  timeoutMs = 180_000,
): Promise<string> {
  const url = `${creds.host}/services/NetSuitePort_${endpointVersion}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
  <soap-env:Header>
    ${soapTokenPassport(creds, endpointVersion)}
  </soap-env:Header>
  <soap-env:Body>${body}</soap-env:Body>
</soap-env:Envelope>`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: action,
        },
        body: envelope,
        signal: ctl.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `SuiteTalk SOAP HTTP ${response.status}: ${text.slice(0, 500)}`,
        );
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 2_000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("SuiteTalk SOAP request failed after retries");
}

export function parseSoapTransactionSearchPage(text: string): {
  transactionIds: string[];
  searchId: string | null;
  totalPages: number;
} {
  if (!text.includes('isSuccess="true"')) {
    const message = text.match(/<(?:\w+:)?message[^>]*>([^<]*)<\/(?:\w+:)?message>/);
    throw new Error(
      `SuiteTalk SOAP transaction search failed: ${message?.[1] ?? text.slice(0, 300)}`,
    );
  }
  const transactionIds = new Set<string>();
  for (const match of text.matchAll(/<(?:\w+:)?record\b([^>]*)>/g)) {
    const internalId = match[1]?.match(/\binternalId="(\d+)"/)?.[1];
    if (internalId) transactionIds.add(internalId);
  }
  const searchId =
    text.match(/<(?:\w+:)?searchId>([^<]+)<\/(?:\w+:)?searchId>/)?.[1] ??
    null;
  const totalPages = Number(
    text.match(
      /<(?:\w+:)?totalPages>(\d+)<\/(?:\w+:)?totalPages>/,
    )?.[1] ?? 0,
  );
  return {
    transactionIds: [...transactionIds],
    searchId,
    totalPages: Number.isSafeInteger(totalPages) ? totalPages : 0,
  };
}

/**
 * Resolve every transaction related to one file through indexed SuiteTalk
 * joins. This is bounded by the requested file identity: it does not enumerate
 * the account's transaction or file populations.
 */
export async function netsuiteSoapTransactionIdsForFile(
  fileId: string,
  creds: NetSuiteCreds,
  endpointVersion = "2022_1",
): Promise<string[]> {
  if (!/^\d+$/.test(fileId)) throw new Error("NetSuite file id must be numeric");
  const transactionIds = new Set<string>();
  for (const join of ["fileJoin", "lineFileJoin"] as const) {
    const searchBody = `<search xmlns="urn:messages_${endpointVersion}.platform.webservices.netsuite.com">
      <searchRecord xsi:type="tranSales:TransactionSearch"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xmlns:tranSales="urn:sales_${endpointVersion}.transactions.webservices.netsuite.com"
        xmlns:platformCommon="urn:common_${endpointVersion}.platform.webservices.netsuite.com"
        xmlns:platformCore="urn:core_${endpointVersion}.platform.webservices.netsuite.com">
        <tranSales:${join}>
          <platformCommon:internalId operator="anyOf">
            <platformCore:searchValue internalId="${fileId}"/>
          </platformCommon:internalId>
        </tranSales:${join}>
      </searchRecord>
    </search>`;
    let pageText = await netsuiteSoapRequest(
      "search",
      searchBody,
      creds,
      endpointVersion,
      60_000,
    );
    let page = parseSoapTransactionSearchPage(pageText);
    for (const transactionId of page.transactionIds) {
      transactionIds.add(transactionId);
    }
    if (page.totalPages > 1 && !page.searchId) {
      throw new Error(
        `SuiteTalk SOAP transaction search omitted its search id for file ${fileId}`,
      );
    }
    for (let pageIndex = 2; pageIndex <= page.totalPages; pageIndex++) {
      pageText = await netsuiteSoapRequest(
        "searchMoreWithId",
        `<searchMoreWithId xmlns="urn:messages_${endpointVersion}.platform.webservices.netsuite.com">
          <searchId>${xmlAttribute(page.searchId!)}</searchId>
          <pageIndex>${pageIndex}</pageIndex>
        </searchMoreWithId>`,
        creds,
        endpointVersion,
        60_000,
      );
      page = parseSoapTransactionSearchPage(pageText);
      for (const transactionId of page.transactionIds) {
        transactionIds.add(transactionId);
      }
    }
  }
  return [...transactionIds].sort((left, right) => Number(left) - Number(right));
}

/**
 * File-cabinet content through SuiteTalk SOAP (TokenPassport, HMAC-SHA256).
 *
 * This is the ONLY NetSuite read path without a ~10MB ceiling: the RESTlet
 * transport hits `File.getContents()`'s 10.0MB cap, the FileReader read
 * budget dies when load+reads cross 10MB, and getSegments' iterable cannot
 * be consumed in this runtime. SuiteTalk SOAP returns the complete file as a
 * base64 payload and is therefore used for large attachment reads.
 */
export async function netsuiteSoapFileGet(
  fileId: string,
  creds: NetSuiteCreds,
  endpointVersion = "2022_1",
): Promise<{ name: string; bytes: Buffer }> {
  if (!/^\d+$/.test(fileId)) throw new Error("NetSuite file id must be numeric");
  const url = `${creds.host}/services/NetSuitePort_${endpointVersion}`;
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatureBase = [creds.account, creds.consumerKey, creds.tokenKey, nonce, timestamp].join("&");
  const signatureKey = `${creds.consumerSecret}&${creds.tokenSecret}`;
  const signature = createHmac("sha256", signatureKey).update(signatureBase).digest("base64");
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">
  <soap-env:Header>
    <tokenPassport xmlns="urn:messages_${endpointVersion}.platform.webservices.netsuite.com">
      <account>${creds.account}</account>
      <consumerKey>${creds.consumerKey}</consumerKey>
      <token>${creds.tokenKey}</token>
      <nonce>${nonce}</nonce>
      <timestamp>${timestamp}</timestamp>
      <signature algorithm="HMAC-SHA256">${signature}</signature>
    </tokenPassport>
  </soap-env:Header>
  <soap-env:Body>
    <get xmlns="urn:messages_${endpointVersion}.platform.webservices.netsuite.com">
      <baseRef xsi:type="ns7:RecordRef" type="file" internalId="${fileId}"
        xmlns:ns7="urn:core_${endpointVersion}.platform.webservices.netsuite.com"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
    </get>
  </soap-env:Body>
</soap-env:Envelope>`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 180_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "get" },
        body: envelope,
        signal: ctl.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`SuiteTalk SOAP HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (!text.includes('isSuccess="true"')) {
        const message = text.match(/<message[^>]*>([^<]*)<\/message>/);
        throw new Error(`SuiteTalk SOAP file-get failed for ${fileId}: ${message?.[1] ?? text.slice(0, 300)}`);
      }
      const name = text.match(/<(?:\w+:)?name>([^<]*)<\/(?:\w+:)?name>/)?.[1] ?? "";
      const open = /<(\w+:)?content>/.exec(text);
      if (!open) throw new Error(`SuiteTalk SOAP file-get returned no content for ${fileId}`);
      const contentStart = open.index + open[0].length;
      const closeTag = `</${open[1] ?? ""}content>`;
      const contentEnd = text.indexOf(closeTag, contentStart);
      if (contentEnd < 0) throw new Error(`SuiteTalk SOAP file-get returned truncated content for ${fileId}`);
      const bytes = Buffer.from(text.slice(contentStart, contentEnd).trim(), "base64");
      if (bytes.length === 0) throw new Error(`SuiteTalk SOAP file-get returned empty content for ${fileId}`);
      return { name, bytes };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 2_000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("SuiteTalk SOAP file-get failed after retries");
}
