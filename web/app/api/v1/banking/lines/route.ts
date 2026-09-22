import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationUnmatchedBankLines } from "../../../../../lib/application/banking";

export const runtime = "nodejs";

/** GET /api/v1/banking/lines — unmatched imported statement lines. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/lines", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationUnmatchedBankLines(context, {
        accountId: url.searchParams.get("accountId") ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
