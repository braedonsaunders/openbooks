import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { getApplicationFile } from "../../../../../lib/application/files";

export const runtime = "nodejs";

/** GET /api/v1/files/{id} — File Cabinet metadata. Never contents. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/files/[id]", async (_auth, context) => {
    const { id } = await params;
    return { status: 200, body: await getApplicationFile(context, id) };
  });
}
