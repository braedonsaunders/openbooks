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
  useSecureCookies,
} from "../../../lib/auth-policy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const startedAt = Date.now();
  let body: { email?: unknown; password?: unknown; mfaCode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const context = authRequestContext(req);
  const challengeToken = req.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOGIN_CHALLENGE_COOKIE}=`))
    ?.slice(LOGIN_CHALLENGE_COOKIE.length + 1);
  const result = typeof body.mfaCode === "string"
    ? await completeMfaLogin(challengeToken ? decodeURIComponent(challengeToken) : undefined, body.mfaCode, context)
    : typeof body.email === "string" && typeof body.password === "string"
      ? await login(body.email, body.password, context)
      : null;
  if (!result) return NextResponse.json({ error: "missing credentials" }, { status: 400 });

  // Equalize primary-auth and MFA failure responses without an unconditional
  // sleep after the database/scrypt work has already exceeded the floor.
  const wait = Math.max(0, 500 - (Date.now() - startedAt));
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
      secure: useSecureCookies(),
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
    secure: useSecureCookies(),
    maxAge: SESSION_TTL_S,
    path: "/",
  });
  res.cookies.set(LOGIN_CHALLENGE_COOKIE, "", { httpOnly: true, secure: useSecureCookies(), maxAge: 0, path: "/" });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function DELETE(req: Request) {
  const rawToken = req.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  await revokeSessionToken(rawToken ? decodeURIComponent(rawToken) : undefined);
  const res = NextResponse.json({ ok: true });
  for (const name of [SESSION_COOKIE, LOGIN_CHALLENGE_COOKIE, "ob_active_env"]) {
    res.cookies.set(name, "", { httpOnly: true, secure: useSecureCookies(), maxAge: 0, path: "/" });
  }
  res.headers.set("Cache-Control", "no-store");
  return res;
}
