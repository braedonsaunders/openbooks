/**
 * Microsoft Dynamics 365 Business Central client — OAuth2 (Entra ID / Azure AD,
 * authorization-code) + the Business Central REST API v2.0. Per-tenant like
 * every connector: the Entra app's client id/secret + the org's Entra tenant id
 * and BC environment are entered in the platform UI and sealed on the
 * connection row; per-org tokens are captured by the consent flow.
 *
 * BC specifics:
 *  - Entra endpoints are tenant-scoped: login.microsoftonline.com/{tenantId}/…
 *  - the API scope is the resource's `.default` (app-registration permissions)
 *  - every data call lives under /companies({companyId})/… — the first company
 *    is resolved after consent and sealed on the connection
 *  - list endpoints page with @odata.nextLink; $filter drives incremental pulls
 *    on lastModifiedDateTime
 */

const API_ROOT = "https://api.businesscentral.dynamics.com/v2.0";
const RESOURCE = "https://api.businesscentral.dynamics.com";
const SCOPE = `${RESOURCE}/.default offline_access`;

export interface DynamicsApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The org's Entra (Azure AD) directory/tenant id. */
  aadTenantId: string;
}

export interface DynamicsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
}

function authBase(aadTenantId: string): string {
  return `https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0`;
}

export function authorizeUrl(app: DynamicsApp, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    redirect_uri: app.redirectUri,
    response_mode: "query",
    scope: SCOPE,
    state,
  });
  return `${authBase(app.aadTenantId)}/authorize?${params.toString()}`;
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number }

function toTokens(r: TokenResponse): DynamicsTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + (r.expires_in - 60) * 1000).toISOString(),
  };
}

export async function exchangeCode(app: DynamicsApp, code: string): Promise<DynamicsTokens> {
  const res = await fetch(`${authBase(app.aadTenantId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: app.redirectUri,
      scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`Dynamics token exchange HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

/**
 * App-only token (client-credentials). BC's recommended service-to-service
 * auth — no user, no refresh token, no per-session consent. Requires the app
 * to have an APPLICATION permission (admin-consented) and to be enabled inside
 * BC (Microsoft Entra Applications, with permission sets).
 */
export async function clientCredentialsToken(app: DynamicsApp): Promise<DynamicsTokens> {
  const res = await fetch(`${authBase(app.aadTenantId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "client_credentials",
      scope: `${RESOURCE}/.default`,
    }),
  });
  if (!res.ok) throw new Error(`Dynamics client-credentials HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const r = (await res.json()) as TokenResponse;
  return { accessToken: r.access_token, refreshToken: "", expiresAt: new Date(Date.now() + (r.expires_in - 60) * 1000).toISOString() };
}

export async function refreshTokens(app: DynamicsApp, refreshToken: string): Promise<DynamicsTokens> {
  const res = await fetch(`${authBase(app.aadTenantId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`Dynamics token refresh HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return toTokens((await res.json()) as TokenResponse);
}

export interface DynamicsCompany { id: string; name: string; displayName?: string }

/** The BC companies visible to this token in one environment (post-consent). */
export async function listCompanies(
  accessToken: string,
  aadTenantId: string,
  environment: string,
): Promise<DynamicsCompany[]> {
  const url = `${API_ROOT}/${aadTenantId}/${environment}/api/v2.0/companies`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Dynamics companies HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { value: DynamicsCompany[] }).value ?? [];
}

export class DynamicsClient {
  private tokens: DynamicsTokens;
  private base: string;
  constructor(
    private app: DynamicsApp,
    private environment: string,
    private companyId: string,
    tokens: DynamicsTokens,
    private onRefresh?: (t: DynamicsTokens) => Promise<void> | void,
  ) {
    this.tokens = tokens;
    this.base = `${API_ROOT}/${app.aadTenantId}/${environment}/api/v2.0`;
  }

  private async accessToken(): Promise<string> {
    // App-only (client-credentials) auth: BC's recommended service-to-service
    // flow. No refresh token — mint a fresh app token whenever the cached one
    // expires. Avoids the delegated-consent/refresh fragility entirely.
    if (!this.tokens.accessToken || new Date(this.tokens.expiresAt).getTime() <= Date.now()) {
      this.tokens = await clientCredentialsToken(this.app);
      await this.onRefresh?.(this.tokens);
    }
    return this.tokens.accessToken;
  }

  /** One HTTP call, hard 30s timeout + bounded retry (429/5xx/network). */
  private async send(url: string): Promise<Response> {
    const token = await this.accessToken();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: ctrl.signal,
        });
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
          const ra = Number(res.headers.get("Retry-After"));
          await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : attempt * 2000));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 2000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Dynamics GET failed after 4 attempts: ${String(lastErr)}`);
  }

  /** GET one company-scoped entity (raw OData, no auto-paging). */
  private async raw<T>(path: string, params: Record<string, string> = {}): Promise<{ value: T[]; nextLink?: string }> {
    const url = new URL(`${this.base}/companies(${this.companyId})/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.send(url.toString());
    if (!res.ok) throw new Error(`Dynamics ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { value?: T[]; "@odata.nextLink"?: string };
    return { value: body.value ?? [], nextLink: body["@odata.nextLink"] };
  }

  /** GET all rows of a company-scoped entity, following @odata.nextLink. */
  async list<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let page = await this.raw<T>(path, params);
    out.push(...page.value);
    while (page.nextLink) {
      const res = await this.send(page.nextLink);
      if (!res.ok) throw new Error(`Dynamics ${path} page HTTP ${res.status}`);
      const body = (await res.json()) as { value?: T[]; "@odata.nextLink"?: string };
      out.push(...(body.value ?? []));
      page = { value: [], nextLink: body["@odata.nextLink"] };
    }
    return out;
  }

  /** ISO instant → OData $filter clause on lastModifiedDateTime (incremental). */
  static modifiedSince(since: Date | null): Record<string, string> {
    return since ? { $filter: `lastModifiedDateTime gt ${since.toISOString()}` } : {};
  }
}
