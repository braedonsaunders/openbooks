import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApplicationError } from "../../../../../../lib/application/errors";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../lib/api/v1-request";
import {
  advanceDocumentLifecycle,
  correctPostedDocument,
  voidDocument,
} from "../../../../../../lib/application/documents";

export const runtime = "nodejs";

const ACTIONS = new Set(["submit", "post", "void", "correct"]);
const voidDocumentBody = z.looseObject({
  reason: z.string().optional(),
  reversalDate: z.string().nullable().optional(),
  reversalPeriodId: z.string().nullable().optional(),
});
const correctDocumentBody = z.looseObject({
  correction: z.record(z.string(), z.unknown()),
});

/** POST /api/v1/documents/:id/:action — document lifecycle through the application layer. */
async function handleV1POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/documents/:id/:action", async (_auth, context) => {
    const { id, action } = await params;
    if (!ACTIONS.has(action)) {
      throw new ApplicationError("not_found", `document action ${action} is not published`, 404);
    }
    const idempotencyKey = requireV1IdempotencyKey(request);
    if (action === "submit" || action === "post") {
      const outcome = await advanceDocumentLifecycle(context, {
        documentId: id,
        action,
        idempotencyKey,
      });
      return { status: 200, body: outcome.result, replayed: outcome.replayed };
    }
    if (action === "void") {
      const body = voidDocumentBody.parse(await readV1JsonObject(request));
      const reason = typeof body.reason === "string" ? body.reason : "";
      const outcome = await voidDocument(context, {
        documentId: id,
        reason,
        reversalDate: typeof body.reversalDate === "string" ? body.reversalDate : null,
        reversalPeriodId: typeof body.reversalPeriodId === "string" ? body.reversalPeriodId : null,
        idempotencyKey,
      });
      return { status: 200, body: outcome.result, replayed: outcome.replayed };
    }
    const body = correctDocumentBody.parse(await readV1JsonObject(request));
    const outcome = await correctPostedDocument(context, {
      documentId: id,
      correction: body.correction as never,
      idempotencyKey,
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}

export const POST = defineRoute({
  public: "token",
  handler: ({ request, params }) => handleV1POST(request, { params: Promise.resolve(params as never) } as never),
});
