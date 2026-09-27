import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readV1JsonObject, withV1Request } from "../../../../../../lib/api/v1-request";
import { runApplicationReport } from "../../../../../../lib/application/reports";

const runApplicationReportBody = z.looseObject({
  period: z.string().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const runtime = "nodejs";

/** POST /api/v1/reports/:id/run — execute a saved report through the report engine. */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/reports/:id/run", async (_auth, context) => {
    const { id } = await params;
    const body = runApplicationReportBody.parse(await readV1JsonObject(request));
    return {
      status: 200,
      body: await runApplicationReport(context, {
        definitionId: id,
        period: body.period,
        fromDate: body.fromDate,
        toDate: body.toDate,
      }),
    };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
