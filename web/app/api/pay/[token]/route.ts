import { NextResponse } from "next/server";
import { PaymentAcceptanceError, createCheckoutSession, paymentLinkOrgId } from "@openbooks/engine/src/payment-acceptance.ts";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

/**
 * Public (token-authenticated): create a provider checkout session for a
 * payment link and hand back the hosted redirect URL. The link token is the
 * bearer credential; session creation is idempotent per (link, amount).
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const orgId = await paymentLinkOrgId(token);
  if (!orgId || !(await isFeatureEnabled(orgId, "onlinePayments"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const origin = new URL(req.url).origin;
  try {
    const session = await createCheckoutSession(token, `${origin}/pay/${token}`);
    return NextResponse.json(session);
  } catch (e) {
    const status = e instanceof PaymentAcceptanceError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
