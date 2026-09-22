import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationFolders } from "../../../../../lib/application/files";

export const runtime = "nodejs";

/** GET /api/v1/files/folders — visible File Cabinet folders. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/files/folders", async (_auth, context) => ({
    status: 200,
    body: await listApplicationFolders(context),
  }));
}
