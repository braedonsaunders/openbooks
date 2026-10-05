import { apiErrorResponse } from '@/lib/api/error-response'
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AutopayError, setupContinueUrl, setupTokenOrgId } from "@openbooks/engine/src/payments/autopay.ts";
import { isFeatureEnabled } from "@/lib/features";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Public (token-authenticated): hand back the stored provider setup URL for
 * a setup link. The token is the Bearer [REDACTED] pinned to appBaseUrl() — the same
 * origin invoice mail already uses — never the request Host. This route is
 * CSRF-exempt and sessionless, so a forged Host must not send the customer
 * (and the token) off-site before they save a method.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const orgId = await setupTokenOrgId(token);
  if (!orgId || !(await isFeatureEnabled(orgId, "autopay"))) {
    return notFound("record");
  }
  try {
    const redirectUrl = await setupContinueUrl(token);
    return NextResponse.json({ redirectUrl });
  } catch (e) {
    if (e instanceof AutopayError) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
    // Anonymous callers must never see engine internals (connection strings,
    // provider secrets, stack traces): log the detail against a request id
    // and hand them the id to quote back.
    const requestId = randomUUID();
    console.error(`pay setup continue failed [requestId=${requestId}]`, e);
    return NextResponse.json({ error: "failed to start the setup session", requestId }, { status: 500 });
  }
}
