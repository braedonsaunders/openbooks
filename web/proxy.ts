import { NextResponse, type NextRequest } from "next/server";
import { isSessionRecordActive } from "./lib/auth-session-store";
import { parseSessionTokenFormat, sessionSigningInput } from "./lib/auth-token-format";
import { isPublicPath } from "./lib/proxy-policy";

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
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }
  const token = req.cookies.get("ob_session")?.value;
  const secret = process.env.SESSION_SECRET ?? "";
  if (token && secret) {
    const parsed = await validSignature(token, secret);
    if (parsed && await isSessionRecordActive(token, parsed)) return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
