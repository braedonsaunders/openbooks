import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { requireV1IdempotencyKey, withV1Request } from "../../../../../../lib/api/v1-request";
import { postJournalDocument } from "../../../../../../lib/application/documents";

export const runtime = "nodejs";

/** POST /api/v1/journals/:id/post — journals skip the generic document lifecycle. */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/journals/:id/post", async (_auth, context) => {
    const { id } = await params;
    const outcome = await postJournalDocument(context, {
      documentId: id,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
