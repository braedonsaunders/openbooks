import { NextRequest, NextResponse } from "next/server";
import {
  currentUser,
  listUserSessions,
  revokeOtherUserSessions,
} from "../../../../lib/auth";
import { hasExpectedOrigin } from "../../../../lib/auth-policy";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sessions = await listUserSessions(user.homeUserId, user.sessionId);
  return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const revoked = await revokeOtherUserSessions(user.homeUserId, user.sessionId);
  return NextResponse.json({ ok: true, revoked }, { headers: { "Cache-Control": "no-store" } });
}
