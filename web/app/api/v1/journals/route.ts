import { NextResponse } from "next/server";
import { v1ListRecords } from "../../../../lib/api/v1-records";
import { readV1JsonObject, requireV1IdempotencyKey, withV1Request } from "../../../../lib/api/v1-request";
import {
  createApplicationJournal,
  parseJournalCreateBody,
  requireUuidIdempotencyKey,
} from "../../../../lib/application/journals";

export const runtime = "nodejs";

/**
 * GET /api/v1/journals — list manual journal documents.
 * This static folder already owns /journals/{id}/post, so the catch-all
 * alias never sees this path.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return v1ListRecords(request, "journals", "api/v1/journals");
}

/**
 * POST /api/v1/journals — balanced-line journal create.
 * Same writer as POST /api/journals. The Idempotency-Key must be a UUID;
 * it becomes the document id.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/journals", async (_auth, context) => {
    const outcome = await createApplicationJournal(context, {
      idempotencyKey: requireUuidIdempotencyKey(requireV1IdempotencyKey(request)),
      body: parseJournalCreateBody(await readV1JsonObject(request)),
    });
    return {
      status: outcome.created ? 201 : 200,
      body: outcome.journal,
      replayed: outcome.replayed,
    };
  });
}
