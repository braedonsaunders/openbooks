import { NextResponse, type NextRequest } from "next/server";
import { checkSessionLiveness } from "./lib/session-gate";
import { requireSessionSecret } from "./lib/auth-secret-policy";
import { parseSessionTokenFormat, sessionSigningInput } from "./lib/auth-token-format";
import {
  buildContentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from "./lib/content-security-policy";
import { APP_DOCUMENT_CSP, isAppDocumentRequest } from './lib/apps/document-policy';
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
  // Per-request id, minted at the edge: every denial below carries it, and it
  // travels downstream so route handlers and the error boundaries can quote
  // the same id the operator sees.
  const requestId = crypto.randomUUID();
  const nonce = createContentSecurityPolicyNonce();
  const appDocument = isAppDocumentRequest(pathname, req.method);
  const contentSecurityPolicy = appDocument ? APP_DOCUMENT_CSP : buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);
  // Next derives the nonce for its own framework/Flight scripts from the
  // incoming CSP header. x-nonce is retained for our explicit <Script>.
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });
  const secured = <T,>(response: NextResponse<T>) => {
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    response.headers.set("x-request-id", requestId);
    if (appDocument) {
      response.headers.set("X-Frame-Options", "SAMEORIGIN");
      response.headers.set("Referrer-Policy", "no-referrer");
    }
    return response;
  };
  // The session store is unreachable (database stall, failover, network
  // partition): fail THIS request closed with a retryable 503 — never throw,
  // which Next would render as a bare 500 with no request id and no boundary.
  const unavailable = () => {
    if (pathname.startsWith("/api/")) {
      const response = NextResponse.json({ error: "unavailable", requestId }, { status: 503 });
      response.headers.set("Retry-After", "5");
      return secured(response);
    }
    return secured(
      new NextResponse(unavailablePage(requestId), {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "Retry-After": "5" },
      }),
    );
  };

  // CSRF gate: forged cross-site mutations ride the session cookie, so every
  // unsafe-method request on a cookie-authenticated surface must present an
  // Origin/Referer matching this deployment. Token-authenticated surfaces are
  // exempt (isCsrfExemptPath) and non-browser clients send no Origin.
  if (isUnsafeMethod(req.method) && !isCsrfExemptPath(pathname) && !hasTrustedOrigin(req)) {
    return secured(
      pathname.startsWith("/api/")
        ? NextResponse.json({ error: "forbidden", requestId }, { status: 403 })
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
    if (parsed) {
      const liveness = await checkSessionLiveness(token, parsed);
      if (liveness === "active") return secured(next());
      if (liveness === "unavailable") return unavailable();
    }
  }
  if (pathname.startsWith("/api/")) {
    return secured(NextResponse.json({ error: "unauthorized", requestId }, { status: 401 }));
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return secured(NextResponse.redirect(url));
}

/**
 * Self-contained 503 document for page navigations that arrive while the
 * session store is unreachable. Deliberately dependency-free (no app shell,
 * no translations, no database): the failure it reports may be exactly why
 * those cannot load. The request id lets an operator correlate with server
 * logs; the retry replays the original navigation.
 */
function unavailablePage(requestId: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Service unavailable</title>` +
    `<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f8fafc;color:#0f172a;` +
    `margin:0;display:grid;place-items:center;min-height:100vh}` +
    `main{max-width:28rem;padding:2rem;text-align:center}` +
    `h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#475569;font-size:.875rem;line-height:1.5}` +
    `code{font-size:.75rem;background:#e2e8f0;padding:.125rem .375rem;border-radius:.25rem}` +
    `a.retry{display:inline-block;margin-top:1rem;background:#0f766e;color:#fff;border:0;` +
    `border-radius:.375rem;padding:.625rem 1.25rem;font-size:.875rem;cursor:pointer;` +
    `text-decoration:none}</style></head>` +
    `<body><main><h1>Service unavailable</h1>` +
    `<p>The server could not be reached for this request, so nothing was ` +
    `changed. Try again in a moment.</p>` +
    `<p>Reference <code>${requestId}</code></p>` +
    // Plain same-document link: replays the current navigation as a GET with
    // no script, so the retry works under the nonce-only script-src policy
    // that blocks inline handlers such as onclick. An empty href resolves to
    // the current URL (query string included); no request target is embedded,
    // so there is no open-redirect surface.
    `<a class="retry" href="">Try again</a>` +
    `</main></body></html>`;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
