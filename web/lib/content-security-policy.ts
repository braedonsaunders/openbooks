const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Build the per-request browser policy used by the Next.js proxy. The nonce is
 * deliberately validated before interpolation so a future caller cannot turn
 * a header value into a policy injection primitive.
 */
export function buildContentSecurityPolicy(nonce: string, development: boolean): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error("CSP nonce must be an unpadded base64url value");
  }

  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(development ? ["'unsafe-eval'"] : []),
  ];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    // React component style attributes and several embedded editors currently
    // require inline styles. Scripts remain nonce-only in production.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/** Generate an unpredictable, URL-safe 128-bit nonce without Node-only APIs. */
export function createContentSecurityPolicyNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
