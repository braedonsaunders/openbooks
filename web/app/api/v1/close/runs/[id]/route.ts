import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../../lib/api/v1-request";
import { getCloseRun } from "../../../../../../lib/application/close";

export const runtime = "nodejs";

/** GET /api/v1/close/runs/:id */
async function handleV1GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/runs/:id", async (_auth, context) => {
    const { id } = await params;
    return { status: 200, body: await getCloseRun(context, id) };
  });
}

export const GET = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1GET(request, { params: Promise.resolve(params as never) } as never),
});
