import { NextRequest, NextResponse } from "next/server";
import {
  currentUser,
  revokeUserSession,
  SESSION_COOKIE,
} from "../../../../../lib/auth";
import { hasExpectedOrigin, secureCookiesEnabled } from "../../../../../lib/auth-policy";
import { isUuid } from "@openbooks/engine/src/platform/uuid.ts";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid session" }, { status: 400 });
  const result = await revokeUserSession(user.homeUserId, id, user.sessionId);
  if (!result.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!result.revoked) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const response = NextResponse.json({ ok: true, current: id === user.sessionId });
  if (id === user.sessionId) {
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: secureCookiesEnabled(),
      maxAge: 0,
      path: "/",
    });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
