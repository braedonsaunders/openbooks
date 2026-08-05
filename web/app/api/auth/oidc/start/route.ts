import { NextRequest, NextResponse } from "next/server";
import { beginOidcAuthorization, OIDC_FLOW_COOKIE } from "../../../../../lib/auth-oidc";
import { useSecureCookies } from "../../../../../lib/auth-policy";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const flow = await beginOidcAuthorization(request.nextUrl.searchParams.get("next"));
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
