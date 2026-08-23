/**
 * CSRF gate for the Next.js proxy (Edge runtime — Web-standard APIs only, no
 * `node:` imports).
 *
 * Cross-site forgeries ride the victim's ambient `ob_session` cookie. An
 * attacker page can send the cookie but cannot forge a matching Origin/Referer
 * and cannot suppress the Origin header on a browser-initiated unsafe request
 * (form or fetch), so host-validating those headers rejects every forged
 * mutation while passing all real browser traffic.
 *
 * Requests carrying neither header are non-browser clients (curl, Playwright's
 * API context, server-to-server callers) — allowed through, mirroring the
 * established `hasExpectedOrigin` semantic in auth-policy.ts; legacy-browser
 * gaps are covered by the SameSite=Lax session cookie. Token-authenticated
 * surfaces are exempt entirely (`isCsrfExemptPath`). This module deliberately
 * duplicates none of auth-policy: that file imports `node:net`, which the Edge
 * runtime cannot bundle.
 */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

function firstForwardedHost(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first || null;
}

/**
 * Host (hostname[:port], scheme-insensitive because TLS commonly terminates at
 * the reverse proxy) this deployment is reached through. The operator-declared
 * OPENBOOKS_APP_URL wins when set; otherwise the outermost forwarded host
 * (set by the trusted edge) or the request URL itself.
 */
export function trustedRequestHost(
  headers: Pick<Headers, "get">,
  environment: Record<string, string | undefined>,
  fallbackUrl: string,
): string {
  const configured = environment.OPENBOOKS_APP_URL;
  if (configured) return new URL(configured).host.toLowerCase();
  const forwarded = firstForwardedHost(headers.get("x-forwarded-host"));
  if (forwarded) return forwarded;
  return new URL(fallbackUrl).host.toLowerCase();
}

type OriginCheckedRequest = { method: string; headers: Headers; url: string };

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    // Includes the literal "null" origin sent from sandboxed contexts.
    return null;
  }
}

/**
 * True when an unsafe-method request presents no cross-site origin evidence:
 * a supplied Origin must match the deployment host, else a supplied Referer
 * must; requests with neither are non-browser clients and pass. Unparseable
 * browser-supplied values fail closed.
 */
export function hasTrustedOrigin(
  req: OriginCheckedRequest,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (!isUnsafeMethod(req.method)) return true;
  let expected: string;
  try {
    expected = trustedRequestHost(req.headers, environment, req.url);
  } catch {
    // A misconfigured canonical URL must never silently widen the policy.
    throw new Error("OPENBOOKS_APP_URL must be a valid absolute URL");
  }
  const origin = req.headers.get("origin");
  if (origin) return hostOf(origin) === expected;
  const referer = req.headers.get("referer");
  if (referer) return hostOf(referer) === expected;
  return true;
}
