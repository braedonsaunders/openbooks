/**
 * QuickBooks Online client — OAuth2 (authorization-code) + the accounting API.
 * Every credential is PER-TENANT: the QBO app's client id/secret are entered in
 * the platform UI and sealed on the connection row; per-company access/refresh
 * tokens are captured by the consent flow and sealed on the same row.
 *
 * Endpoints (stable):
 *   authorize : https://appcenter.intuit.com/connect/oauth2
 *   token     : https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *   api       : https://{sandbox-,}quickbooks.api.intuit.com/v3/company/{realmId}
 */

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";
const MINOR_VERSION = "75";

export interface QboApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: "sandbox" | "production";
}

export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO expiry of the access token. */
  expiresAt: string;
}

export function apiBase(environment: QboApp["environment"]): string {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

/** Build the Intuit consent URL. `state` round-trips org/connection through Intuit. */
export function authorizeUrl(app: QboApp, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: app.redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuth(app: QboApp): string {
  return "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function toTokens(r: TokenResponse): QboTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + (r.expires_in - 60) * 1000).toISOString(),
  };
}

/** Exchange an authorization code for the first token pair. */
export async function exchangeCode(app: QboApp, code: string): Promise<QboTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: app.redirectUri }),
  });
  if (!res.ok) throw new Error(`QBO token exchange HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

/** Refresh an expired access token (the refresh token may rotate). */
export async function refreshTokens(app: QboApp, refreshToken: string): Promise<QboTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(app), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`QBO token refresh HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

/**
 * Live QBO API session for one company. Refreshes the access token on demand
 * and reports new tokens through `onRefresh` so callers persist them (sealed).
 */
export class QboClient {
  private tokens: QboTokens;
  constructor(
    private app: QboApp,
    private realmId: string,
    tokens: QboTokens,
    private onRefresh?: (t: QboTokens) => Promise<void> | void,
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

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await this.accessToken();
    const url = new URL(`${apiBase(this.app.environment)}/v3/company/${this.realmId}/${path}`);
    url.searchParams.set("minorversion", MINOR_VERSION);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`QBO ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** One page of a QBO query (entity array under QueryResponse.<Entity>). */
  private async queryPage<T>(statement: string): Promise<T[]> {
    const data = await this.get<{ QueryResponse?: Record<string, unknown> }>("query", { query: statement });
    for (const v of Object.values(data.QueryResponse ?? {})) if (Array.isArray(v)) return v as T[];
    return [];
  }

  /** Query ALL rows of an entity (STARTPOSITION pagination, 1000/page). */
  async queryAll<T = Record<string, unknown>>(entity: string, where = "", orderBy = "Id"): Promise<T[]> {
    const out: T[] = [];
    const page = 1000;
    for (let start = 1; ; start += page) {
      const rows = await this.queryPage<T>(
        `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ""} ORDERBY ${orderBy} STARTPOSITION ${start} MAXRESULTS ${page}`,
      );
      out.push(...rows);
      if (rows.length < page) return out;
    }
  }

  /** Fetch a report (TrialBalance, …) as its raw JSON. */
  async report<T = Record<string, unknown>>(name: string, params: Record<string, string> = {}): Promise<T> {
    return this.get<T>(`reports/${name}`, params);
  }

  /** Company accounting preferences, including fiscal year and close date. */
  async preferences<T = Record<string, unknown>>(): Promise<T> {
    return this.get<T>("preferences");
  }
}
