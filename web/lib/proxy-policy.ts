const EXACT_PUBLIC_PATHS = new Set([
  "/login",
  "/login/reset",
  "/api/login",
  "/api/password-reset",
  "/api/auth/methods",
  "/api/flows/email-action",
  "/api/v1/health",
  "/api/v1/openapi",
  "/api/v1/schema",
  // Sessionless BY DESIGN: the MCP endpoint authenticates every request with
  // an API key inside the route (resolveApiKeyAuth, fail-closed) — the same
  // model as /api/v1/records. The session gate would 302 agents to /login.
  "/mcp",
  "/favicon.ico",
  "/icon.svg",
  "/socialmedia.png",
]);

const PUBLIC_SEGMENT_ROOTS = [
  "/api/auth/oidc",
  "/api/v1/records",
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
