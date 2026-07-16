import { NextResponse, type NextRequest } from "next/server";

/**
 * Session gate. Edge runtime: verify the HMAC cookie with Web Crypto —
 * user-row checks happen server-side in pages/APIs via currentUser().
 */

// /api/flows/email-action is sessionless BY DESIGN: one-click email approvals
// carry their own HMAC token (verified in the route) instead of a cookie.
const PUBLIC = ["/login", "/api/login", "/api/v1/", "/api/flows/email-action", "/favicon.ico"];

async function validSignature(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [uid, exp, sig] = parts;
  if (Number(exp) < Date.now() / 1000) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${uid}.${exp}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return expected === sig;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p)) || pathname.startsWith("/_next")) {
    return NextResponse.next();
  }
  const token = req.cookies.get("ob_session")?.value;
  const secret = process.env.SESSION_SECRET ?? "";
  if (token && secret && (await validSignature(token, secret))) {
    return NextResponse.next();
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
