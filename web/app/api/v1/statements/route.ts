import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { getApplicationPartnerStatement } from "../../../../lib/application/aging-read";

export const runtime = "nodejs";

/** GET /api/v1/statements — one customer or vendor statement. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/statements", async (_auth, context) => {
    const url = new URL(request.url);
    return {
      status: 200,
      body: await getApplicationPartnerStatement(context, {
        partyId: url.searchParams.get("partyId") ?? "",
        side: url.searchParams.get("side") ?? "",
        from: url.searchParams.get("from") ?? "",
        to: url.searchParams.get("to") ?? "",
      }),
    };
  });
}
