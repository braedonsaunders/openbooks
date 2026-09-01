import { NextRequest, NextResponse } from "next/server";
import { beginOidcAuthorization, oidcAppUrl, OIDC_FLOW_COOKIE } from "../../../../../lib/auth-oidc";
import { safeReturnTo, useSecureCookies } from "../../../../../lib/auth-policy";

export const runtime = "nodejs";

function safeOidcNext(value: string | null): string {
  const candidate = safeReturnTo(value);
  try {
    const appOrigin = new URL(oidcAppUrl()).origin;
    return new URL(candidate, appOrigin).origin === appOrigin ? candidate : "/";
  } catch {
    return "/";
  }
}

export async function GET(request: NextRequest) {
  try {
    const flow = await beginOidcAuthorization(safeOidcNext(request.nextUrl.searchParams.get("next")));
    const response = NextResponse.redirect(flow.url);
    response.cookies.set(OIDC_FLOW_COOKIE, flow.flowCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: useSecureCookies(),
      maxAge: 10 * 60,
      path: "/api/auth/oidc",
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("[auth] OIDC start failed:", (error as Error).message);
    return NextResponse.json({ error: "single sign-on unavailable" }, { status: 503 });
  }
}
