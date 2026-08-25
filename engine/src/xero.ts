/**
 * Xero client — OAuth2 (authorization-code, PKCE-optional web app) + the
 * accounting API. Per-tenant like every connector: the Xero app's client
 * id/secret are entered in the platform UI and sealed on the connection row;
 * org tokens + the Xero tenantId are captured by the consent flow.
 *
 * Xero specifics:
 *  - refresh tokens ROTATE on every refresh — callers must persist via onRefresh
 *  - after token exchange, GET /connections yields the authorized tenant(s);
 *    every API call carries `xero-tenant-id`
 *  - list endpoints paginate with ?page=N (100/page); the Journals endpoint
 *    paginates by ?offset=<last JournalNumber>
 *  - incremental pulls use the If-Modified-Since header
 */

const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const API = "https://api.xero.com/api.xro/2.0";
// GRANULAR scopes (mandatory for apps created after 2 Mar 2026; broad scopes
// like accounting.transactions no longer exist for them). Read-only set:
//  - invoices.read       → Invoices, CreditNotes, Items
//  - payments.read       → Payments (and batch/over/prepayments)
//  - banktransactions.read → BankTransactions + BankTransfers
//  - manualjournals.read / contacts.read / settings.read (accounts, tax rates, org)
//  - reports.trialbalance.read → the TB report (the Journals endpoint is now
//    Advanced-tier-gated, so verification reads the report instead)
const SCOPE =
  "offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.payments.read accounting.banktransactions.read accounting.manualjournals.read accounting.reports.trialbalance.read";

export interface XeroApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * A deterministic security refusal, not a transient fault: something tried to
 * bounce a credentialed Xero request off-origin via an HTTP redirect. Callers
 * (and XeroClient.send's retry loop) must surface it immediately instead of
 * retrying or following.
 */
class XeroRedirectRefused extends Error {}

/**
 * Xero credentials must never cross an HTTP redirect boundary. Even a trusted
 * origin can otherwise redirect a request — carrying the Basic-auth client
 * secret or bearer token, and for POSTs the whole body — to a host that was
 * never allowlisted. Manual mode keeps every hop under our control; undici
 * surfaces the real 3xx response (not a browser-style opaque one), so any
 * redirect with a Location is refused outright rather than followed.
 */
async function xeroFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: "manual" });
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (location !== null) {
    throw new XeroRedirectRefused(
      `Xero request to ${typeof url === "string" ? url : url.href} attempted an HTTP ${res.status} redirect to ${location}; credentialed requests are never followed`,
    );
  }
  return res;
}

export interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
}

export function authorizeUrl(app: XeroApp, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuth(app: XeroApp): string {
  return "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number }

function toTokens(r: TokenResponse): XeroTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + (r.expires_in - 60) * 1000).toISOString(),
  };
}

export async function exchangeCode(app: XeroApp, code: string): Promise<XeroTokens> {
  const res = await xeroFetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: app.redirectUri }),
  });
  if (!res.ok) throw new Error(`Xero token exchange HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

export async function refreshTokens(app: XeroApp, refreshToken: string): Promise<XeroTokens> {
  const res = await xeroFetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Xero token refresh HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

/** The tenants this token pair is authorized for (post-consent handshake). */
export async function listConnections(accessToken: string): Promise<{ tenantId: string; tenantName: string }[]> {
  const res = await xeroFetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Xero connections HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = (await res.json()) as { tenantId: string; tenantName?: string }[];
  return rows.map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName ?? r.tenantId }));
}

/** Xero serializes dates as "/Date(1699999999999+0000)/" — normalize to ISO. */
export function xeroDate(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  const m = v.match(/\/Date\((\d+)/);
  if (m) return new Date(Number(m[1])).toISOString();
  return v; // already ISO (e.g. DateString fields)
}

export class XeroClient {
  private tokens: XeroTokens;
  constructor(
    private app: XeroApp,
    private tenantId: string,
    tokens: XeroTokens,
    private onRefresh?: (t: XeroTokens) => Promise<void> | void,
  ) {
    this.tokens = tokens;
  }

  private async accessToken(): Promise<string> {
    if (new Date(this.tokens.expiresAt).getTime() <= Date.now()) {
      this.tokens = await refreshTokens(this.app, this.tokens.refreshToken);
      await this.onRefresh?.(this.tokens);
    }
    return this.tokens.accessToken;
  }

  /**
   * One HTTP call with a hard per-attempt timeout and bounded retry. Xero over
   * a network tunnel can stall a socket indefinitely (a bare fetch has no
   * timeout); we also retry Xero's 429 rate limit and transient 5xx. Non-retry
   * 4xx errors surface immediately, and so do redirect refusals — they are a
   * deterministic answer from the origin, not a flaky network.
   */
  private async send(method: string, url: URL, headers: Record<string, string>, body?: unknown): Promise<Response> {
    const TIMEOUT_MS = 30_000;
    const MAX_ATTEMPTS = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await xeroFetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(res.headers.get("Retry-After"));
          await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : attempt * 2000));
          continue;
        }
        return res;
      } catch (e) {
        if (e instanceof XeroRedirectRefused) throw e; // never follow, never retry
        lastErr = e; // network error / timeout abort — retry with backoff
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Xero ${method} ${url.pathname} failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
  }

  async get<T>(path: string, params: Record<string, string> = {}, modifiedSince?: Date | null): Promise<T> {
    const token = await this.accessToken();
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "xero-tenant-id": this.tenantId,
      Accept: "application/json",
    };
    if (modifiedSince) headers["If-Modified-Since"] = modifiedSince.toISOString();
    const res = await this.send("GET", url, headers);
    if (!res.ok) throw new Error(`Xero ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** Page through a list endpoint (?page=N, 100/page). `key` = response array. */
  async listAll<T>(path: string, key: string, params: Record<string, string> = {}, modifiedSince?: Date | null): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const data = await this.get<Record<string, T[]>>(path, { ...params, page: String(page) }, modifiedSince);
      const rows = data[key] ?? [];
      out.push(...rows);
      if (rows.length < 100) return out;
    }
  }

}
