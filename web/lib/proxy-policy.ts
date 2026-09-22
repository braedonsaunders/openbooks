const EXACT_PUBLIC_PATHS = new Set([
  "/login",
  "/login/reset",
  "/api/login",
  "/api/password-reset",
  "/api/auth/methods",
  "/api/flows/email-action",
  // Sessionless BY DESIGN: the MCP endpoint authenticates every request with
  // an API key inside the route (resolveApiKeyAuth, fail-closed) — the same
  // model as /api/v1. The session gate would 302 agents to /login.
  "/mcp",
  "/favicon.ico",
  "/icon.svg",
  "/socialmedia.png",
]);

const PUBLIC_SEGMENT_ROOTS = [
  "/api/auth/oidc",
  // The whole versioned API segment is sessionless BY DESIGN: every route
  // under /api/v1 authenticates with a Bearer API key inside the route
  // (withV1Request / resolveApiKeyAuth / guardApiKey, all fail-closed 401)
  // and no v1 route reads the session cookie — the session gate would 401
  // every API-key client before the route could see the key. /api/v1/health
  // is the one intentionally unauthenticated route (process liveness).
  // A new v1 route that relied on the session cookie would silently become
  // public: web/lib/public-surface-contract.test.ts derives every v1 route
  // from the filesystem and refuses exactly that.
  "/api/v1",
  "/pay",
  "/api/pay",
  "/api/payments/webhooks",
  // External counterparty signing: /sign pages and /api/sign endpoints carry
  // their own per-request HMAC token, verified inside every route
  // (verifySigningToken + validateSigningRequest, fail-closed) — recipients
  // have no account, so the session gate would 302 every signer to /login.
  "/sign",
  "/api/sign",
  // Desktop-connector SOAP bridge (/api/qbd): the desktop client holds no
  // session cookie — the route authenticates every call itself (the
  // connection's user-chosen password, then unguessable session tickets).
  // Same credential-authenticated non-browser model as /api/pay and /api/sign.
  "/api/qbd",
  // HR-18 begin: recruiting public surface, co-signed by security.
  // /careers is the public career page, /book and /offer are the candidate
  // self-booking and offer-signing pages. Candidates have no account, so
  // the session gate would 302 every one of them to /login.
  "/careers",
  "/book",
  "/offer",
  // The four API routes are named ONE BY ONE on purpose. A bare recruiting
  // API root would make every future sibling sessionless and CSRF-exempt the
  // moment the file lands — admin, reports, candidate PII — and a comment
  // saying otherwise would be a claim about today's folder, not a constraint
  // the code enforces. Child segments still match, so the token routes below
  // cover their /<token> children. Adding a fifth route is then a decision
  // someone records here, which is what this list is for.
  "/api/recruiting/apply",
  "/api/recruiting/book",
  "/api/recruiting/offer",
  "/api/recruiting/feed",
  // HR-18 end
  // Worker-to-web seam: every /api/internal route authenticates itself with
  // the shared OPENBOOKS_INTERNAL_TOKEN header and fails closed without it.
  "/api/internal",
] as const;

/** Match either the exact route or a child segment, never a near prefix. */
function matchesSegment(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/**
 * Forwarded Host/Proto/For are security input only when the operator opts in
 * and the reverse proxy strips client-supplied copies before setting its own
 * values. Same gate as `authRequestContext` — kept here so the Edge CSRF
 * module can honor it without importing `node:net`.
 */
export function trustsForwardedHeaders(
  environment: Record<string, string | undefined>,
): boolean {
  return /^(1|true|yes)$/i.test(environment.OPENBOOKS_TRUST_PROXY ?? "");
}

export function isPublicPath(pathname: string): boolean {
  return EXACT_PUBLIC_PATHS.has(pathname)
    || PUBLIC_SEGMENT_ROOTS.some((root) => matchesSegment(pathname, root))
    || matchesSegment(pathname, "/_next");
}

/**
 * Surfaces the CSRF gate must skip: every request here authenticates with an
 * explicit credential (API key, internal token, provider HMAC signature, or a
 * secret link token) that browsers never attach to cross-site requests, so
 * those routes have no ambient-cookie forgery surface. `/mcp` carries the same
 * API-key model (see EXACT_PUBLIC_PATHS). Everything else — including public
 * browser forms like /api/login and /api/password-reset — is origin-checked.
 */
export function isCsrfExemptPath(pathname: string): boolean {
  return pathname === "/mcp"
    || PUBLIC_SEGMENT_ROOTS.some((root) => matchesSegment(pathname, root));
}
