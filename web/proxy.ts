import { NextResponse, type NextRequest } from "next/server";
import { isSessionRecordActive } from "./lib/auth-session-store";
import { requireSessionSecret } from "./lib/auth-secret-policy";
import { parseSessionTokenFormat, sessionSigningInput } from "./lib/auth-token-format";
import {
  buildContentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from "./lib/content-security-policy";
import { isPublicPath, isCsrfExemptPath } from "./lib/proxy-policy";
import { hasTrustedOrigin, isUnsafeMethod } from "./lib/csrf";

/**
 * Session gate. Edge runtime: verify the HMAC cookie with Web Crypto —
 * user-row checks happen server-side in pages/APIs via currentUser().
 */

// /api/flows/email-action is sessionless BY DESIGN: one-click email approvals
// carry their own HMAC token (verified in the route) instead of a cookie.
// /pay + /api/pay are the hosted payment-link pages (random 192-bit bearer
// tokens); /api/payments/webhooks verifies provider HMAC signatures internally.
async function validSignature(token: string, secret: string) {
  const parsed = parseSessionTokenFormat(token);
  if (!parsed || parsed.expiresEpoch < Date.now() / 1000) return null;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionSigningInput(parsed.payload)));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (expected.length !== parsed.signature.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ parsed.signature.charCodeAt(index);
  }
  return difference === 0 ? parsed : null;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = createContentSecurityPolicyNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next derives the nonce for its own framework/Flight scripts from the
  // incoming CSP header. x-nonce is retained for our explicit <Script>.
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });
  const secured = <T,>(response: NextResponse<T>) => {
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
  };

  // CSRF gate: forged cross-site mutations ride the session cookie, so every
  // unsafe-method request on a cookie-authenticated surface must present an
  // Origin/Referer matching this deployment. Token-authenticated surfaces are
  // exempt (isCsrfExemptPath) and non-browser clients send no Origin.
  if (isUnsafeMethod(req.method) && !isCsrfExemptPath(pathname) && !hasTrustedOrigin(req)) {
    return secured(
      pathname.startsWith("/api/")
        ? NextResponse.json({ error: "forbidden" }, { status: 403 })
        : new NextResponse("cross-origin request rejected", { status: 403 }),
    );
  }

  if (isPublicPath(pathname)) {
    return secured(next());
  }
  const token = req.cookies.get("ob_session")?.value;
  const secret = requireSessionSecret(process.env);
  if (token) {
    const parsed = await validSignature(token, secret);
    if (parsed && await isSessionRecordActive(token, parsed)) return secured(next());
  }
  if (pathname.startsWith("/api/")) {
    return secured(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return secured(NextResponse.redirect(url));
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
