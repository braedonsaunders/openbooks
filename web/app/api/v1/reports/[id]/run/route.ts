import { NextResponse } from "next/server";
import { readV1JsonObject, withV1Request } from "../../../../../../lib/api/v1-request";
import { runApplicationReport } from "../../../../../../lib/application/reports";

export const runtime = "nodejs";

/** POST /api/v1/reports/:id/run — execute a saved report through the report engine. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/reports/:id/run", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    return {
      status: 200,
      body: await runApplicationReport(context, {
        definitionId: id,
        period: typeof body.period === "string" ? body.period : undefined,
        fromDate: typeof body.fromDate === "string" ? body.fromDate : undefined,
        toDate: typeof body.toDate === "string" ? body.toDate : undefined,
      }),
    };
  });
}
