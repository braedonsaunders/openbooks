import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from "@/lib/api/route";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  beginMfaSetup,
  confirmMfaSetup,
  currentUser,
  disableMfa,
  getMfaStatus,
} from "../../../../lib/auth";
import { authRequestContext, hasExpectedOrigin, publicMfaSecurityFailure } from "../../../../lib/auth-policy";

const setupBody = z.object({ password: z.string() });
const confirmBody = z.object({ code: z.string().max(64) });
const disableBody = z.object({ password: z.string(), code: z.string() });

/**
 * A second session's pending setup is refused by name at 409 with the
 * remedy intact. beginMfaSetup throws it as a plain Error, which the
 * sanitizer would otherwise genericize to a 500.
 */
class MfaSetupPendingRefusal extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "MfaSetupPendingRefusal";
  }
}

export const GET = defineRoute({ public: "session", handler: async () => {
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getMfaStatus(user.homeUserId), { headers: { "Cache-Control": "no-store" } });
} });

export const POST = defineRoute({ public: "session", body: setupBody, handler: async ({ request, body }) => {
  const nextRequest = request as NextRequest;
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (typeof body?.password !== "string") {
    return NextResponse.json({ error: "password required" }, { status: 400 });
  }
  try {
    const setup = await beginMfaSetup(
      user.homeUserId,
      user.sessionId,
      body.password,
      authRequestContext(nextRequest),
    );
    if (!setup) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    return NextResponse.json(setup, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "MFA is already enabled") {
      return NextResponse.json({ error: "MFA is already enabled" }, { status: 409 });
    }
    if (error instanceof Error && error.message.startsWith("MFA setup is already pending in another session;")) {
      return apiErrorResponse(new MfaSetupPendingRefusal(error.message));
    }
    console.error("[auth] unable to begin MFA setup:", error);
    return NextResponse.json({ error: "unable to begin MFA setup" }, { status: 500 });
  }
} });

export const PUT = defineRoute({ public: "session", body: confirmBody, handler: async ({ request, body }) => {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (typeof body?.code !== "string" || body.code.length > 64) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }
  const recoveryCodes = await confirmMfaSetup(user.homeUserId, user.sessionId, body.code);
  if (!recoveryCodes) return NextResponse.json({ error: "invalid code" }, { status: 400 });
  return NextResponse.json({ ok: true, recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
} });

export const DELETE = defineRoute({ public: "session", body: disableBody, handler: async ({ request, body }) => {
  const nextRequest = request as NextRequest;
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Matches the login route's timing floor: a wrong password and a wrong MFA
  // code must be indistinguishable by response time as well as by message.
  const startedAt = Date.now();
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (typeof body?.password !== "string" || typeof body.code !== "string") {
    return NextResponse.json({ error: "password and code required" }, { status: 400 });
  }
  const result = await disableMfa(
    user.homeUserId,
    body.password,
    body.code,
    user.sessionId,
    authRequestContext(nextRequest),
  );
  const wait = Math.max(0, 500 - (Date.now() - startedAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  if (!result.ok) {
    const failure = publicMfaSecurityFailure({
      reason: result.reason,
      retryAfter: result.reason === "rate_limited" || result.reason === "locked" ? result.retryAfter : 0,
    });
    return NextResponse.json(failure.body, {
      status: failure.status,
      headers: {
        ...(failure.retryAfterHeader ? { "Retry-After": failure.retryAfterHeader } : {}),
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
} });
