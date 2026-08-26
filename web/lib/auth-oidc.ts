import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@openbooks/engine/src/db.ts";
import { safeReturnTo } from "./auth-policy";
import { requireSessionSecret } from "./auth-secret-policy";
import { verifyOidcIdToken, type VerifiedOidcClaims } from "./auth-oidc-token";

export const OIDC_FLOW_COOKIE = "ob_oidc_flow";
const FLOW_TTL_S = 10 * 60;
function sessionSecret(): string {
  return requireSessionSecret(env);
}

type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  appUrl: string;
};

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
};

type OidcFlow = {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresEpoch: number;
};

type OidcRuntime = typeof globalThis & {
  __openbooksOidcDiscovery?: { key: string; value: Discovery; expiresAt: number };
  __openbooksOidcJwks?: { key: string; value: Record<string, unknown>[]; expiresAt: number };
};
const runtime = globalThis as OidcRuntime;

function config(): OidcConfig | null {
  const issuer = env.OPENBOOKS_OIDC_ISSUER?.trim().replace(/\/+$/, "");
  const clientId = env.OPENBOOKS_OIDC_CLIENT_ID?.trim();
  const appUrl = env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (!issuer || !clientId || !appUrl) return null;
  assertSecureEndpoint(issuer, "OIDC issuer");
  const parsedApp = new URL(appUrl);
  if (env.NODE_ENV === "production" && parsedApp.protocol !== "https:") {
    throw new Error("OPENBOOKS_APP_URL must use HTTPS when OIDC is enabled in production");
  }
  return { issuer, clientId, clientSecret: env.OPENBOOKS_OIDC_CLIENT_SECRET?.trim() || null, appUrl };
}

export function oidcEnabled(): boolean {
  return config() !== null;
}

export function oidcLabel(): string {
  return env.OPENBOOKS_OIDC_LABEL?.trim().slice(0, 80) || "Single sign-on";
}

function assertSecureEndpoint(value: string, label: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && local)) {
    throw new Error(`${label} must use HTTPS`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain URL credentials`);
  return url;
}

/** OIDC traffic must never cross an HTTP redirect boundary. The token
 *  exchange authenticates the tenant with its client secret (form body or
 *  Basic header), and fetch follows redirects by default — a 307/308 preserves
 *  method AND body, re-issuing that secret to whichever host the Location
 *  names. Discovery and JWKS carry no secret themselves, but a redirected
 *  discovery document chooses where the NEXT request sends the secret and a
 *  redirected JWKS chooses which signing keys are trusted, so every outbound
 *  OIDC call fails closed instead of following. */
function oidcFetch(url: string | URL, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" });
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  assertSecureEndpoint(url, "OIDC endpoint");
  const response = await oidcFetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC endpoint returned ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 1_000_000) throw new Error("OIDC response is too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > 1_000_000) throw new Error("OIDC response is too large");
  const result = JSON.parse(text);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("OIDC response is invalid");
  return result as Record<string, unknown>;
}

async function discovery(configuration: OidcConfig): Promise<Discovery> {
  const cached = runtime.__openbooksOidcDiscovery;
  if (cached?.key === configuration.issuer && cached.expiresAt > Date.now()) return cached.value;
  const raw = await fetchJson(`${configuration.issuer}/.well-known/openid-configuration`);
  const value: Discovery = {
    issuer: String(raw.issuer ?? ""),
    authorization_endpoint: String(raw.authorization_endpoint ?? ""),
    token_endpoint: String(raw.token_endpoint ?? ""),
    jwks_uri: String(raw.jwks_uri ?? ""),
    token_endpoint_auth_methods_supported: Array.isArray(raw.token_endpoint_auth_methods_supported)
      ? raw.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === "string")
      : undefined,
  };
  if (value.issuer !== configuration.issuer) throw new Error("OIDC discovery issuer mismatch");
  assertSecureEndpoint(value.authorization_endpoint, "OIDC authorization endpoint");
  assertSecureEndpoint(value.token_endpoint, "OIDC token endpoint");
  assertSecureEndpoint(value.jwks_uri, "OIDC JWKS endpoint");
  runtime.__openbooksOidcDiscovery = { key: configuration.issuer, value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
}

async function jwks(url: string): Promise<Record<string, unknown>[]> {
  const cached = runtime.__openbooksOidcJwks;
  if (cached?.key === url && cached.expiresAt > Date.now()) return cached.value;
  const raw = await fetchJson(url);
  if (!Array.isArray(raw.keys)) throw new Error("OIDC JWKS has no keys array");
  const keys = raw.keys.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  runtime.__openbooksOidcJwks = { key: url, value: keys, expiresAt: Date.now() + 10 * 60 * 1000 };
  return keys;
}

function flowSignature(payload: string): string {
  return createHmac("sha256", sessionSecret())
    .update(`openbooks:oidc-flow:${payload}`)
    .digest("base64url");
}

function encodeFlow(flow: OidcFlow): string {
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  return `o1.${payload}.${flowSignature(payload)}`;
}

function decodeFlow(value: string | undefined): OidcFlow | null {
  if (!value || value.length > 4096) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "o1") return null;
  const payload = parts[1]!;
  const signature = parts[2]!;
  const expected = flowSignature(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcFlow;
    if (
      !flow
      || typeof flow.state !== "string"
      || typeof flow.nonce !== "string"
      || typeof flow.verifier !== "string"
      || typeof flow.returnTo !== "string"
      || !Number.isSafeInteger(flow.expiresEpoch)
      || flow.expiresEpoch < Date.now() / 1000
    ) return null;
    return { ...flow, returnTo: safeReturnTo(flow.returnTo) };
  } catch {
    return null;
  }
}

function redirectUri(configuration: OidcConfig): string {
  return `${configuration.appUrl}/api/auth/oidc/callback`;
}

function oauthFormEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

export async function beginOidcAuthorization(returnToValue: string | null): Promise<{ url: string; flowCookie: string }> {
  const configuration = config();
  if (!configuration) throw new Error("OIDC is not configured");
  const metadata = await discovery(configuration);
  const verifier = randomBytes(32).toString("base64url");
  const flow: OidcFlow = {
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    verifier,
    returnTo: safeReturnTo(returnToValue),
    expiresEpoch: Math.floor(Date.now() / 1000) + FLOW_TTL_S,
  };
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: configuration.clientId,
    redirect_uri: redirectUri(configuration),
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), flowCookie: encodeFlow(flow) };
}

export async function completeOidcAuthorization(input: {
  code: string;
  state: string;
  flowCookie: string | undefined;
}): Promise<{ claims: VerifiedOidcClaims; returnTo: string }> {
  const configuration = config();
  const flow = decodeFlow(input.flowCookie);
  if (!configuration || !flow || input.state !== flow.state || input.code.length > 4096) {
    throw new Error("OIDC flow validation failed");
  }
  const metadata = await discovery(configuration);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: redirectUri(configuration),
    client_id: configuration.clientId,
    code_verifier: flow.verifier,
  });
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (configuration.clientSecret) {
    if (metadata.token_endpoint_auth_methods_supported?.includes("client_secret_post")
      && !metadata.token_endpoint_auth_methods_supported.includes("client_secret_basic")) {
      body.set("client_secret", configuration.clientSecret);
    } else {
      headers.Authorization = `Basic ${Buffer.from(`${oauthFormEncode(configuration.clientId)}:${oauthFormEncode(configuration.clientSecret)}`).toString("base64")}`;
    }
  }
  const response = await oidcFetch(metadata.token_endpoint, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC token exchange returned ${response.status}`);
  const tokenText = await response.text();
  if (Buffer.byteLength(tokenText) > 1_000_000) throw new Error("OIDC token response is too large");
  const tokens = JSON.parse(tokenText) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string" || tokens.id_token.length > 64_000) throw new Error("OIDC response has no valid ID token");
  let keys = await jwks(metadata.jwks_uri);
  let claims = verifyOidcIdToken({
    idToken: tokens.id_token,
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    nonce: flow.nonce,
    keys,
  });
  // A provider key rotation can race the short cache. Refresh once.
  if (!claims) {
    runtime.__openbooksOidcJwks = undefined;
    keys = await jwks(metadata.jwks_uri);
    claims = verifyOidcIdToken({
      idToken: tokens.id_token,
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      nonce: flow.nonce,
      keys,
    });
  }
  if (!claims) throw new Error("OIDC ID token validation failed");
  return { claims, returnTo: flow.returnTo };
}

export function oidcAppUrl(): string {
  return config()?.appUrl ?? env.OPENBOOKS_APP_URL ?? "http://localhost:4780";
}
