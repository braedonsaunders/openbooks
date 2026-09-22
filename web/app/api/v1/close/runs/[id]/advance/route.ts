import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../../../lib/application/errors";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "../../../../../../../lib/api/v1-request";
import { advanceCloseRun } from "../../../../../../../lib/application/close";

export const runtime = "nodejs";

const ACTIONS = new Set(["refresh", "request_approval", "attest", "close", "publish"]);

/** POST /api/v1/close/runs/:id/advance */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withV1Request(request, "api/v1/close/runs/:id/advance", async (_auth, context) => {
    const { id } = await params;
    const body = await readV1JsonObject(request);
    const action = String(body.action ?? "");
    if (!ACTIONS.has(action)) {
      throw new ApplicationError(
        "invalid_input",
        "action must be refresh, request_approval, attest, close, or publish",
        422,
      );
    }
    const outcome = await advanceCloseRun(context, {
      runId: id,
      action: action as "refresh" | "request_approval" | "attest" | "close" | "publish",
      comment: typeof body.comment === "string" ? body.comment : undefined,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: 200, body: outcome.result, replayed: outcome.replayed };
  });
}
