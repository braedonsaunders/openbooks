import { defineRoute } from "@/lib/api/route";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "../../../../lib/auth";
import { changeOwnPassword } from "../../../../lib/auth-password-change";
import { MIN_PASSWORD_LENGTH } from "../../../../lib/auth-reset";
import { authRequestContext, hasExpectedOrigin } from "../../../../lib/auth-policy";

export const runtime = "nodejs";

const changeBody = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});

const noStore = { "Cache-Control": "no-store" };

/**
 * Change the signed-in user's password. Requires the current password,
 * keeps this session signed in and signs out every other session.
 */
export const PUT = defineRoute({
  public: "session",
  body: changeBody,
  handler: async ({ request, body }) => {
    const nextRequest = request as NextRequest;
    if (!hasExpectedOrigin(request))
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const user = await currentUser();
    if (!user?.sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!body.currentPassword) {
      return NextResponse.json(
        { error: "Enter your current password.", code: "current_password_required" },
        { status: 400, headers: noStore },
      );
    }
    const result = await changeOwnPassword({
      userId: user.homeUserId,
      sessionId: user.sessionId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      context: authRequestContext(nextRequest),
    });
    if (result.ok) {
      return NextResponse.json(
        { ok: true, otherSessionsSignedOut: result.revokedSessions },
        { headers: noStore },
      );
    }
    switch (result.reason) {
      case "weak_password":
        return NextResponse.json(
          {
            error: `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.`,
            code: "weak_password",
            minLength: MIN_PASSWORD_LENGTH,
          },
          { status: 400, headers: noStore },
        );
      case "unchanged_password":
        return NextResponse.json(
          {
            error: "Choose a new password that is different from your current password.",
            code: "unchanged_password",
          },
          { status: 400, headers: noStore },
        );
      case "invalid_credentials":
        return NextResponse.json(
          { error: "Your current password is incorrect.", code: "invalid_current_password" },
          { status: 400, headers: noStore },
        );
      case "rate_limited":
      case "locked":
        return NextResponse.json(
          { error: "Too many attempts. Try again later.", retryAfter: result.retryAfter },
          { status: 429, headers: { ...noStore, "Retry-After": String(result.retryAfter) } },
        );
      case "busy":
        return NextResponse.json(
          { error: "Sign-in is busy right now. Try again in a moment.", code: "busy" },
          { status: 503, headers: { ...noStore, "Retry-After": "5" } },
        );
      case "caller_session_revoked":
        return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
    }
  },
});
