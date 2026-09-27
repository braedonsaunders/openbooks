import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { completePasswordReset, requestPasswordReset } from "../../../lib/auth-reset";
import { authRequestContext, hasExpectedOrigin } from "../../../lib/auth-policy";

const requestResetBodySchema = z.object({ email: z.string().trim().min(1).max(320) });
const completeResetBodySchema = z.object({ token: z.string().min(1).max(2048), password: z.string().min(1).max(1024) });


export const runtime = "nodejs";

/**
 * POST { email } — request a reset link. Always 200 after a uniform delay:
 * whether the address matched an account is never observable here.
 */


/** PUT { token, password } — consume the link and set the new password. */


export const POST = defineRoute({
  public: "token",
  body: requestResetBodySchema,
  handler: async ({ request, body }) => {

    if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const startedAt = Date.now();


    if (typeof body.email !== "string") {
      return NextResponse.json({ error: "missing email" }, { status: 400 });
    }
    try {
      await requestPasswordReset(body.email, authRequestContext(request));
    } catch (error) {
      // Uniform response even on transport/database trouble; the failure is
      // server-visible via logs and email_log.
      console.error("[password-reset] request failed", error);
    }
    const wait = Math.max(0, 500 - (Date.now() - startedAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  },
});

export const PUT = defineRoute({
  public: "token",
  body: completeResetBodySchema,
  handler: async ({ request, body }) => {

    if (!hasExpectedOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });


    if (typeof body.token !== "string" || typeof body.password !== "string") {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }
    const outcome = await completePasswordReset(body.token, body.password);
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.reason },
        { status: 422, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  },
});
