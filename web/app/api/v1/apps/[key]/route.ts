import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { getExtensionPackage } from "../../../../../lib/application/extensions";

export const runtime = "nodejs";

/**
 * GET /api/v1/apps/[key] — read the installed package (or one historical
 * version via `?versionId=`) before preparing an upgrade or rollback.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/apps/:key", async (_auth, context) => {
    const { key } = await params;
    const versionId = new URL(request.url).searchParams.get("versionId") ?? undefined;
    return { status: 200, body: { ok: true, ...(await getExtensionPackage(context, { key, versionId })) } };
  });
}
