import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationBankFeeds } from "../../../../../lib/application/banking";

export const runtime = "nodejs";

/** GET /api/v1/banking/feeds — feed connections. Credentials are never returned. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/banking/feeds", async (_auth, context) => ({
    status: 200,
    body: await listApplicationBankFeeds(context),
  }));
}
