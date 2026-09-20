import { randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { appBaseUrl } from "@openbooks/engine/src/flows/email-tokens.ts";
import { sealJson, unsealJson } from "@openbooks/engine/src/platform/secrets.ts";
import { useSecureCookies } from "../../../../../lib/auth-policy";

/**
 * Connection OAuth CSRF follows the house OIDC cookie+nonce pattern
 * (`ob_oidc_flow`, 10-minute TTL, HttpOnly / SameSite=Lax) and the house
 * seal for the provider `state` blob. The sealed org/connection pair alone
 * is not a nonce: a stolen blob would otherwise replay forever.
 */
export const CONNECTION_OAUTH_COOKIE = "ob_connection_oauth";
export const CONNECTION_OAUTH_TTL_S = 10 * 60;
const COOKIE_PATH = "/api/platform/connections/oauth";

export type ConnectionOauthProvider = "xero" | "qbo" | "dynamics";

export type ConnectionOauthState = {
  orgId: string;
  connectionId: string;
  nonce: string;
  exp: number;
};

export function connectionAppOrigin(): string {
  return appBaseUrl();
}

export function connectionOauthRedirectUri(provider: ConnectionOauthProvider): string {
  return `${connectionAppOrigin()}/api/platform/connections/oauth/${provider}/callback`;
}

export function mintConnectionOauthState(orgId: string, connectionId: string): {
  state: string;
  nonce: string;
} {
  const nonce = randomBytes(24).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + CONNECTION_OAUTH_TTL_S;
  return { state: sealJson({ orgId, connectionId, nonce, exp }), nonce };
}

export function attachConnectionOauthCookie(response: NextResponse, nonce: string): void {
  response.cookies.set(CONNECTION_OAUTH_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookies(),
    maxAge: CONNECTION_OAUTH_TTL_S,
    path: COOKIE_PATH,
  });
  response.headers.set("Cache-Control", "no-store");
}

export function clearConnectionOauthCookie(response: NextResponse): void {
  response.cookies.set(CONNECTION_OAUTH_COOKIE, "", {
    httpOnly: true,
    secure: useSecureCookies(),
    maxAge: 0,
    path: COOKIE_PATH,
  });
}

export function connectionOauthBounce(status: string): NextResponse {
  const response = NextResponse.redirect(new URL(`/sync?oauth=${status}`, `${connectionAppOrigin()}/`));
  clearConnectionOauthCookie(response);
  return response;
}

export function connectionOauthCookieValue(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== CONNECTION_OAUTH_COOKIE) continue;
    const raw = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function sameNonce(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function acceptConnectionOauthState(
  sealed: string,
  cookieNonce: string | null,
): ConnectionOauthState | null {
  const st = unsealJson<Partial<ConnectionOauthState>>(sealed);
  if (
    !st
    || typeof st.orgId !== "string"
    || !st.orgId
    || typeof st.connectionId !== "string"
    || !st.connectionId
    || typeof st.nonce !== "string"
    || st.nonce.length < 16
    || !Number.isSafeInteger(st.exp)
    || st.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  if (!cookieNonce || !sameNonce(st.nonce, cookieNonce)) return null;
  return { orgId: st.orgId, connectionId: st.connectionId, nonce: st.nonce, exp: st.exp };
}

/**
 * Pin a provider tenant/company to a prior stored id, or to the only row
 * when none is stored. More than one unbound row is an ambiguous bind and
 * must be refused by name — never `items[0]`.
 */
export function pinProviderChoice<T>(
  items: T[],
  priorId: string | undefined,
  idOf: (item: T) => string,
  emptyStatus: "notenant" | "nocompany",
): { ok: true; item: T } | { ok: false; status: "ambiguous" | "notenant" | "nocompany" } {
  if (priorId) {
    const match = items.find((item) => idOf(item) === priorId);
    if (!match) return { ok: false, status: emptyStatus };
    return { ok: true, item: match };
  }
  if (items.length === 1) return { ok: true, item: items[0]! };
  if (items.length === 0) return { ok: false, status: emptyStatus };
  return { ok: false, status: "ambiguous" };
}
