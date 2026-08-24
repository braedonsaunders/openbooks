import { NextResponse } from "next/server";
import { handleProviderWebhook, type AcceptanceProvider } from "@openbooks/engine/src/payment-acceptance.ts";

export const runtime = "nodejs";

/**
 * Provider payment webhooks. Signature verification happens inside the engine
 * against each configured org's sealed webhook secret BEFORE any processing —
 * an unverifiable delivery is a 401 and no org context is ever resolved.
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "stripe" && provider !== "adyen" && provider !== "gocardless") {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  }
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const result = await handleProviderWebhook(provider as AcceptanceProvider, headers, rawBody);
  if (!result) {
    return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
  }
  // Always 200 once authenticated, including recognized deliveries containing
  // no actionable event types. Provider retries on 4xx/5xx would otherwise
  // redeliver forever; idempotency makes retries safe anyway.
  return NextResponse.json({
    received: true,
    status: result.status,
    events: result.eventResults.map(({ externalRef, status }) => ({ externalRef, status })),
  });
}
