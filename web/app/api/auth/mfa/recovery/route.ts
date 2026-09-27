import { defineRoute } from "@/lib/api/route";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, rotateRecoveryCodes } from "../../../../../lib/auth";
import { authRequestContext, hasExpectedOrigin, publicMfaSecurityFailure } from "../../../../../lib/auth-policy";

const recoveryBody = z.object({ password: z.string(), code: z.string() });

export const POST = defineRoute({ public: "session", body: recoveryBody, handler: async ({ request, body }) => {
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
  const result = await rotateRecoveryCodes(
    user.homeUserId,
    user.sessionId,
    body.password,
    body.code,
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
  return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
} });
