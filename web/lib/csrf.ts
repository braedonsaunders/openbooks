/**
 * CSRF gate for the Next.js proxy (Edge runtime — Web-standard APIs only, no
 * `node:` imports).
 *
 * Cross-site forgeries ride the victim's ambient `ob_session` cookie. An
 * attacker page can send the cookie but cannot forge a matching Origin/Referer
 * and cannot suppress the Origin header on a browser-initiated unsafe request
 * (form or fetch), so exact-origin validation rejects every forged mutation
 * while passing real browser traffic.
 *
 * Unsafe requests carrying neither header fail closed. Non-browser callers
 * must either send the deployment Origin or use a token-authenticated surface
 * exempted by `isCsrfExemptPath`. This module deliberately duplicates none of
 * auth-policy: that file imports `node:net`, which the Edge runtime cannot
 * bundle. `trustsForwardedHeaders` lives in proxy-policy for the same reason.
 */

import { trustsForwardedHeaders } from "./proxy-policy";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

function firstForwardedValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    // Includes the literal "null" origin sent from sandboxed contexts.
    return null;
  }
}

/**
 * Loopback literals that name this machine (`localhost`, `127.0.0.1`,
 * `[::1]`). Invite links, harness base URLs, and browser address bars mix
 * them freely on one machine; origins must treat them as the same host.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Exact-origin comparison with loopback equivalence: scheme and port stay
 * exact, and only loopback literals interchange — a real host, a spoofed
 * suffix, or a different loopback-family member (e.g. 127.0.0.2) still
 * rejects. Shared by the edge gate below and the route-level
 * `hasExpectedOrigin` in `auth-policy.ts`. Web-standard APIs only: safe for
 * the Edge runtime.
 */
export function isSameLoopbackOrigin(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.protocol !== right.protocol || left.port !== right.port) return false;
    const leftHost = left.hostname.toLowerCase();
    const rightHost = right.hostname.toLowerCase();
    if (leftHost === rightHost) return true;
    return LOOPBACK_HOSTS.has(leftHost) && LOOPBACK_HOSTS.has(rightHost);
  } catch {
    return false;
  }
}

function suppliedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function forwardedRequestOrigin(
  headers: Pick<Headers, "get">,
  fallbackUrl: string,
): string | null {
  const host = firstForwardedValue(headers.get("x-forwarded-host"));
  if (!host) return null;

  const forwardedProtocol = firstForwardedValue(
    headers.get("x-forwarded-proto"),
  );
  let protocol = forwardedProtocol?.toLowerCase();
  if (!protocol) {
    try {
      protocol = new URL(fallbackUrl).protocol.slice(0, -1);
    } catch {
      return null;
    }
  }
  if (protocol !== "http" && protocol !== "https") return null;

  try {
    const url = new URL(`${protocol}://${host}`);
    if (
      url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Origin (scheme://hostname[:port]) this deployment is reached through. The
 * operator-declared OPENBOOKS_APP_URL wins when set. An unset canonical URL
 * is unknown: client-supplied X-Forwarded-Host must not become the trusted
 * origin. Honor OPENBOOKS_TRUST_PROXY before treating the outermost
 * forwarded pair as the edge; otherwise the request URL is the only origin
 * the process can know.
 */
export function trustedRequestOrigin(
  headers: Pick<Headers, "get">,
  environment: Record<string, string | undefined>,
  fallbackUrl: string,
): string | null {
  const configured = environment.OPENBOOKS_APP_URL;
  if (configured) {
    const origin = httpOrigin(configured);
    if (!origin) throw new Error("OPENBOOKS_APP_URL must be a valid HTTP(S) URL");
    return origin;
  }
  if (
    trustsForwardedHeaders(environment)
    && headers.get("x-forwarded-host") !== null
  ) {
    return forwardedRequestOrigin(headers, fallbackUrl);
  }
  return httpOrigin(fallbackUrl);
}

type OriginCheckedRequest = { method: string; headers: Headers; url: string };

/**
 * True when an unsafe-method request presents same-origin evidence: a supplied
 * Origin must match the deployment origin, else a supplied Referer must.
 * Missing or unparseable browser-supplied values fail closed.
 */
export function hasTrustedOrigin(
  req: OriginCheckedRequest,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (!isUnsafeMethod(req.method)) return true;
  const expected = trustedRequestOrigin(req.headers, environment, req.url);
  if (!expected) return false;
  const origin = req.headers.get("origin");
  if (origin !== null) {
    const supplied = suppliedOrigin(origin);
    return supplied !== null && isSameLoopbackOrigin(supplied, expected);
  }
  const referer = req.headers.get("referer");
  if (referer !== null) {
    const refererOrigin = httpOrigin(referer);
    return refererOrigin !== null && isSameLoopbackOrigin(refererOrigin, expected);
  }
  return false;
}
