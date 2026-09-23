import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextRequest, NextResponse } from "next/server";
import { currentUser, rotateRecoveryCodes } from "../../../../../lib/auth";
import { authRequestContext, hasExpectedOrigin, publicMfaSecurityFailure } from "../../../../../lib/auth-policy";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Matches the login route's timing floor: a wrong password and a wrong MFA
  // code must be indistinguishable by response time as well as by message.
  const startedAt = Date.now();
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { password?: unknown; code?: unknown } | null;
  if (typeof body?.password !== "string" || typeof body.code !== "string") {
    return NextResponse.json({ error: "password and code required" }, { status: 400 });
  }
  const result = await rotateRecoveryCodes(
    user.homeUserId,
    user.sessionId,
    body.password,
    body.code,
    authRequestContext(request),
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
}
