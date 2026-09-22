import { NextResponse } from "next/server";
import { guardPermission } from "../../../lib/authz";
import { parseJsonBody } from "../../../lib/api/json";
import { isUuid } from "../../../lib/list-params";
import {
  createManualJournal,
  journalCreateBody,
  JournalCreateError,
} from "../../../lib/journal-create";

export const runtime = "nodejs";

/**
 * Create one draft manual journal with its lines.
 *
 * The caller supplies a UUID idempotency key, which becomes the document ID.
 * The write itself lives in `createManualJournal` — the only first-party
 * insert path for new journals. POST /api/v1/journals is the public twin.
 */
export async function POST(request: Request) {
  const gate = await guardPermission("gl.post");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }

  const parsed = await parseJsonBody(request, journalCreateBody, { status: 422 });
  if (!parsed.ok) return parsed.response;

  try {
    const result = await createManualJournal({
      orgId: user.orgId,
      userId: user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      idempotencyKey: requestId,
      body: parsed.data,
    });
    return NextResponse.json(result.journal, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof JournalCreateError) {
      return NextResponse.json(error.toJson(), { status: error.status });
    }
    throw error;
  }
}
