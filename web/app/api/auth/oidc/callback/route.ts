import { NextRequest, NextResponse } from "next/server";
import {
  finishOidcLogin,
  LOGIN_CHALLENGE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_S,
} from "../../../../../lib/auth";
import {
  completeOidcAuthorization,
  oidcAppUrl,
  OIDC_FLOW_COOKIE,
} from "../../../../../lib/auth-oidc";
import { authRequestContext, useSecureCookies } from "../../../../../lib/auth-policy";

export const runtime = "nodejs";

function loginRedirect(error?: string) {
  const url = new URL("/login", oidcAppUrl());
  if (error) url.searchParams.set("error", error);
  return url;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const providerError = request.nextUrl.searchParams.get("error");
  if (!code || !state || providerError) return NextResponse.redirect(loginRedirect("sso"));
  try {
    const oidc = await completeOidcAuthorization({
      code,
      state,
      flowCookie: request.cookies.get(OIDC_FLOW_COOKIE)?.value,
    });
    const result = await finishOidcLogin({
      ...oidc.claims,
      context: authRequestContext(request),
    });
    if (result.kind === "invalid" || result.kind === "rate_limited") {
      return NextResponse.redirect(loginRedirect("sso"));
    }
    const destination = new URL(result.kind === "mfa_required" ? "/login" : oidc.returnTo, oidcAppUrl());
    if (result.kind === "mfa_required") {
      destination.searchParams.set("mfa", "1");
      destination.searchParams.set("next", oidc.returnTo);
    }
    const response = NextResponse.redirect(destination);
    response.cookies.set(OIDC_FLOW_COOKIE, "", {
      httpOnly: true,
      secure: useSecureCookies(),
      maxAge: 0,
      path: "/api/auth/oidc",
    });
    if (result.kind === "mfa_required") {
      response.cookies.set(LOGIN_CHALLENGE_COOKIE, result.challengeToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: useSecureCookies(),
        maxAge: 5 * 60,
        path: "/",
      });
    } else {
      response.cookies.set(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: useSecureCookies(),
        maxAge: SESSION_TTL_S,
        path: "/",
      });
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("[auth] OIDC callback failed:", (error as Error).message);
    const response = NextResponse.redirect(loginRedirect("sso"));
    response.cookies.set(OIDC_FLOW_COOKIE, "", {
      httpOnly: true,
      secure: useSecureCookies(),
      maxAge: 0,
      path: "/api/auth/oidc",
    });
    return response;
  }
}
