import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationCurrencies } from "../../../../lib/application/fx-read";

export const runtime = "nodejs";

/** GET /api/v1/currencies — ISO registry plus this org's base currency. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/currencies", async (_auth, context) => ({
    status: 200,
    body: await listApplicationCurrencies(context),
  }));
}
