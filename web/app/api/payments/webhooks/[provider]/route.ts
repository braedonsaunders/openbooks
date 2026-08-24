import { NextResponse } from "next/server";
import {
  handleProviderWebhook,
  PaymentWebhookBatchError,
  type AcceptanceProvider,
  type ProviderWebhookResult,
} from "@openbooks/engine/src/payment-acceptance.ts";

export const runtime = "nodejs";

function webhookResponse(result: ProviderWebhookResult, status = 200) {
  return NextResponse.json(
    {
      received: true,
      status: result.status,
      events: result.eventResults.map(({ externalRef, status: eventStatus }) => ({
        externalRef,
        status: eventStatus,
      })),
    },
    { status },
  );
}

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
  let result: ProviderWebhookResult | null;
  try {
    result = await handleProviderWebhook(provider as AcceptanceProvider, headers, rawBody);
  } catch (error) {
    if (error instanceof PaymentWebhookBatchError) {
      // Every event was attempted independently before this response. A 5xx
      // asks the provider to retry failed members; committed members safely
      // dedupe on replay instead of being rolled back or processed twice.
      return webhookResponse(error.result, 500);
    }
    throw error;
  }
  if (!result) {
    return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
  }
  // Authenticated deliveries with no actionable events are acknowledged; a
  // processing failure instead takes the explicit retry path above.
  return webhookResponse(result);
}
