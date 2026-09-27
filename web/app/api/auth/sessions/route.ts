import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  currentUser,
  listUserSessions,
  revokeOtherUserSessions,
} from "../../../../lib/auth";
import { hasExpectedOrigin } from "../../../../lib/auth-policy";

export const GET = defineRoute({ public: "session", handler: async () => {
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sessions = await listUserSessions(user.homeUserId, user.sessionId);
  return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
} });

export const DELETE = defineRoute({ public: "session", handler: async ({ request }) => {
  if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await currentUser();
  if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await revokeOtherUserSessions(user.homeUserId, user.sessionId);
  if (!result.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, revoked: result.revoked }, { headers: { "Cache-Control": "no-store" } });
} });
