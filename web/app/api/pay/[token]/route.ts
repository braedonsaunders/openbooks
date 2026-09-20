import { NextResponse } from "next/server";
import { appBaseUrl } from "@openbooks/engine/src/flows/email-tokens.ts";
import { PaymentAcceptanceError, createCheckoutSession, paymentLinkOrgId } from "@openbooks/engine/src/payments/acceptance.ts";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

/**
 * Public (token-authenticated): create a provider checkout session for a
 * payment link and hand back the hosted redirect URL. The link token is the
 * bearer credential; session creation is idempotent per (link, amount).
 *
 * PSP success/cancel URLs carry this bearer token. They are pinned to
 * appBaseUrl() — the same origin invoice mail already uses for /pay/{token}
 * — never the request Host. This route is CSRF-exempt and sessionless, so a
 * forged Host must not send the customer (and the token) off-site after they
 * pay.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const orgId = await paymentLinkOrgId(token);
  if (!orgId || !(await isFeatureEnabled(orgId, "onlinePayments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const origin = appBaseUrl();
  try {
    const session = await createCheckoutSession(token, `${origin}/pay/${token}`);
    return NextResponse.json(session);
  } catch (e) {
    const status = e instanceof PaymentAcceptanceError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
