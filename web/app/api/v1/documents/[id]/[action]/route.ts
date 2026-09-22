import { NextResponse } from "next/server";
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

/** POST /api/v1/documents/:id/:action — document lifecycle through the application layer. */
export async function POST(
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
    const body = await readV1JsonObject(request);
    if (action === "void") {
      const reason = typeof body.reason === "string" ? body.reason : "";
      const outcome = await voidDocument(context, {
        documentId: id,
        reason,
        reversalDate: typeof body.reversalDate === "string" ? body.reversalDate : null,
        idempotencyKey,
      });
      return { status: 200, body: outcome.result, replayed: outcome.replayed };
    }
    const outcome = await correctPostedDocument(context, {
      documentId: id,
      correction: body.correction as never,
      idempotencyKey,
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
