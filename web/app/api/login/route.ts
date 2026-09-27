import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import {
  completeMfaLogin,
  login,
  LOGIN_CHALLENGE_COOKIE,
  revokeSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_S,
} from "../../../lib/auth";
import {
  authRequestContext,
  publicLoginFailure,
  secureCookiesEnabled,
} from "../../../lib/auth-policy";

const requestBodySchema = z.union([
  z.object({ email: z.string().trim().min(1).max(320), password: z.string().min(1).max(1024), mfaCode: z.string().optional() }),
  z.object({ mfaCode: z.string().trim().min(1).max(32) }),
]);


export const runtime = "nodejs";

/** Wall-clock read for the failure-timing floor below. */
function nowMs(): number {
  return Date.now();
}



async function legacyDELETE(req: Request) {
  const rawToken = req.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  await revokeSessionToken(rawToken ? decodeURIComponent(rawToken) : undefined);
  const res = NextResponse.json({ ok: true });
  for (const name of [SESSION_COOKIE, LOGIN_CHALLENGE_COOKIE, "ob_active_env"]) {
    res.cookies.set(name, "", { httpOnly: true, secure: secureCookiesEnabled(), maxAge: 0, path: "/" });
  }
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const POST = defineRoute({
  public: "token",
  body: requestBodySchema,
  handler: async ({ request, body }) => {

    const startedAt = nowMs();


    const context = authRequestContext(request);
    const challengeToken = request.headers.get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${LOGIN_CHALLENGE_COOKIE}=`))
      ?.slice(LOGIN_CHALLENGE_COOKIE.length + 1);
    const result = typeof body.mfaCode === "string"
      ? await completeMfaLogin(challengeToken ? decodeURIComponent(challengeToken) : undefined, body.mfaCode, context)
      : "email" in body && typeof body.email === "string" && typeof body.password === "string"
        ? await login(body.email, body.password, context)
        : null;
    if (!result) return NextResponse.json({ error: "missing credentials" }, { status: 400 });

    // Equalize primary-auth and MFA failure responses without an unconditional
    // sleep after the database/scrypt work has already exceeded the floor.
    const wait = Math.max(0, 500 - (nowMs() - startedAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));

    if (result.kind === "rate_limited" || result.kind === "invalid") {
      const failure = publicLoginFailure(result);
      return NextResponse.json(
        failure.body,
        {
          status: failure.status,
          headers: {
            ...(failure.retryAfterHeader ? { "Retry-After": failure.retryAfterHeader } : {}),
            "Cache-Control": "no-store",
          },
        },
      );
    }
    if (result.kind === "mfa_required") {
      const response = NextResponse.json({ ok: false, mfaRequired: true }, { status: 202 });
      response.cookies.set(LOGIN_CHALLENGE_COOKIE, result.challengeToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookiesEnabled(),
        maxAge: 5 * 60,
        path: "/",
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookiesEnabled(),
      maxAge: SESSION_TTL_S,
      path: "/",
    });
    res.cookies.set(LOGIN_CHALLENGE_COOKIE, "", { httpOnly: true, secure: secureCookiesEnabled(), maxAge: 0, path: "/" });
    res.headers.set("Cache-Control", "no-store");
    return res;
  },
});

export const DELETE = defineRoute({
  public: "token",
  handler: async ({ request }) => legacyDELETE(request as never),
});
