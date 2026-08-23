import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextRequest, NextResponse } from "next/server";
import { completePasswordReset, requestPasswordReset } from "../../../lib/auth-reset";
import { authRequestContext, hasExpectedOrigin } from "../../../lib/auth-policy";

export const runtime = "nodejs";

/**
 * POST { email } — request a reset link. Always 200 after a uniform delay:
 * whether the address matched an account is never observable here.
 */
export async function POST(req: NextRequest) {
  if (!hasExpectedOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const startedAt = Date.now();
  let body: { email?: unknown };
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  if (typeof body.email !== "string") {
    return NextResponse.json({ error: "missing email" }, { status: 400 });
  }
  try {
    await requestPasswordReset(body.email, authRequestContext(req));
  } catch (error) {
    // Uniform response even on transport/database trouble; the failure is
    // server-visible via logs and email_log.
    console.error("[password-reset] request failed", error);
  }
  const wait = Math.max(0, 500 - (Date.now() - startedAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

/** PUT { token, password } — consume the link and set the new password. */
export async function PUT(req: NextRequest) {
  if (!hasExpectedOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { token?: unknown; password?: unknown };
  try {
    const parsedBody2 = await parseJsonBody(req, jsonObject);
    if (!parsedBody2.ok) return parsedBody2.response;
    body = parsedBody2.data;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
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
}
