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
]);

const PUBLIC_SEGMENT_ROOTS = [
  "/api/auth/oidc",
  "/api/v1/records",
  "/pay",
  "/api/pay",
  "/api/payments/webhooks",
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
