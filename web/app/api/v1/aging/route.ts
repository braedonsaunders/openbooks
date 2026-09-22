import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listApplicationAging, listApplicationAgingDetail } from "../../../../lib/application/aging-read";

export const runtime = "nodejs";

/** GET /api/v1/aging?side=ar|ap — AR/AP collections. view=detail is per-document. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/aging", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const input = {
      side: url.searchParams.get("side") ?? "",
      asOf: url.searchParams.get("asOf") ?? undefined,
      limit: limitRaw ? Number(limitRaw) : undefined,
    };
    if (url.searchParams.get("view") === "detail") {
      return { status: 200, body: await listApplicationAgingDetail(context, input) };
    }
    return {
      status: 200,
      body: await listApplicationAging(context, {
        ...input,
        bucket: url.searchParams.get("bucket") ?? undefined,
      }),
    };
  });
}
