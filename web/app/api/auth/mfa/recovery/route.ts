import { NextRequest, NextResponse } from "next/server";
import { currentUser, rotateRecoveryCodes } from "../../../../../lib/auth";
import { authRequestContext, hasExpectedOrigin } from "../../../../../lib/auth-policy";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { password?: unknown; code?: unknown } | null;
  if (typeof body?.password !== "string" || typeof body.code !== "string") {
    return NextResponse.json({ error: "password and code required" }, { status: 400 });
  }
  const recoveryCodes = await rotateRecoveryCodes(
    user.homeUserId,
    body.password,
    body.code,
    authRequestContext(request),
  );
  if (!recoveryCodes) return NextResponse.json({ error: "invalid code" }, { status: 401 });
  return NextResponse.json({ ok: true, recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
}
