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
const SCOPE = "offline_access accounting.transactions accounting.settings accounting.contacts";

export interface XeroApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: app.redirectUri }),
  });
  if (!res.ok) throw new Error(`Xero token exchange HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

export async function refreshTokens(app: XeroApp, refreshToken: string): Promise<XeroTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Xero token refresh HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

/** The tenants this token pair is authorized for (post-consent handshake). */
export async function listConnections(accessToken: string): Promise<{ tenantId: string; tenantName: string }[]> {
  const res = await fetch("https://api.xero.com/connections", {
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
    const res = await fetch(url, { headers });
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

  /** The Journals endpoint (the GL): paginates by offset=<last JournalNumber>. */
  async journalsAll<T extends { JournalNumber: number }>(modifiedSince?: Date | null): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    for (;;) {
      const data = await this.get<{ Journals: T[] }>("Journals", offset ? { offset: String(offset) } : {}, modifiedSince);
      const rows = data.Journals ?? [];
      out.push(...rows);
      if (rows.length < 100) return out;
      offset = rows[rows.length - 1]!.JournalNumber;
    }
  }
}
