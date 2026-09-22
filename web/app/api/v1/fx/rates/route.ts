import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationFxRates } from "../../../../../lib/application/fx-read";

export const runtime = "nodejs";

/** GET /api/v1/fx/rates?fromCurrency=USD&toCurrency=CAD — dated exact rates. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/fx/rates", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationFxRates(context, {
        fromCurrency: (url.searchParams.get("fromCurrency") ?? "").toUpperCase(),
        toCurrency: (url.searchParams.get("toCurrency") ?? "").toUpperCase(),
        asOf: url.searchParams.get("asOf") ?? undefined,
        rateType: url.searchParams.get("rateType") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
