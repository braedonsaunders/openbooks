import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import {
  currentUser,
  revokeUserSession,
  SESSION_COOKIE,
} from "../../../../../lib/auth";
import { hasExpectedOrigin, secureCookiesEnabled } from "../../../../../lib/auth-policy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DELETE = defineRoute({
  public: "session",
  params: z.object({ id: z.string().regex(UUID, "invalid session") }),
  handler: async ({ request, params }) => {
    if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const user = await currentUser();
    if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = params;
    if (!UUID.test(id)) return NextResponse.json({ error: "invalid session" }, { status: 400 });
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
  },
});
