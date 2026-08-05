const EXACT_PUBLIC_PATHS = new Set([
  "/login",
  "/api/login",
  "/api/auth/methods",
  "/api/flows/email-action",
  "/favicon.ico",
  "/icon.svg",
]);

const PUBLIC_SEGMENT_ROOTS = [
  "/api/auth/oidc",
  "/api/v1",
  "/pay",
  "/api/pay",
  "/api/payments/webhooks",
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
