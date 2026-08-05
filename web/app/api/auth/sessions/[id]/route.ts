import { NextRequest, NextResponse } from "next/server";
import {
  currentUser,
  revokeUserSession,
  SESSION_COOKIE,
} from "../../../../../lib/auth";
import { hasExpectedOrigin, useSecureCookies } from "../../../../../lib/auth-policy";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "invalid session" }, { status: 400 });
  const revoked = await revokeUserSession(user.homeUserId, id);
  if (!revoked) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const response = NextResponse.json({ ok: true, current: id === user.sessionId });
  if (id === user.sessionId) {
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: useSecureCookies(),
      maxAge: 0,
      path: "/",
    });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
