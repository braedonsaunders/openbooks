import { NextResponse } from "next/server";
import { withV1Request } from "../../../../lib/api/v1-request";
import { listSetupEntities } from "../../../../lib/application/setup-read";

export const runtime = "nodejs";

/** GET /api/v1/setup — Setup-registry catalog with this org's feature gates. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/setup", async (_auth, context) => ({
    status: 200,
    body: await listSetupEntities(context),
  }));
}
