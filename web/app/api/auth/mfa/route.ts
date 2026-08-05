import { NextRequest, NextResponse } from "next/server";
import {
  beginMfaSetup,
  confirmMfaSetup,
  currentUser,
  disableMfa,
  getMfaStatus,
} from "../../../../lib/auth";
import { authRequestContext, hasExpectedOrigin } from "../../../../lib/auth-policy";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getMfaStatus(user.homeUserId), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  if (typeof body?.password !== "string") {
    return NextResponse.json({ error: "password required" }, { status: 400 });
  }
  try {
    const setup = await beginMfaSetup(
      user.homeUserId,
      user.sessionId,
      body.password,
      authRequestContext(request),
    );
    if (!setup) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    return NextResponse.json(setup, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "MFA is already enabled") {
      return NextResponse.json({ error: "MFA is already enabled" }, { status: 409 });
    }
    console.error("[auth] unable to begin MFA setup:", error);
    return NextResponse.json({ error: "unable to begin MFA setup" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { code?: unknown } | null;
  if (typeof body?.code !== "string" || body.code.length > 64) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }
  const recoveryCodes = await confirmMfaSetup(user.homeUserId, user.sessionId, body.code);
  if (!recoveryCodes) return NextResponse.json({ error: "invalid code" }, { status: 400 });
  return NextResponse.json({ ok: true, recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { password?: unknown; code?: unknown } | null;
  if (typeof body?.password !== "string" || typeof body.code !== "string") {
    return NextResponse.json({ error: "password and code required" }, { status: 400 });
  }
  const disabled = await disableMfa(
    user.homeUserId,
    body.password,
    body.code,
    user.sessionId,
    authRequestContext(request),
  );
  if (!disabled) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
