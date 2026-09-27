import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";


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


export const POST = defineRoute({
  permission: "gl.post",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: journalCreateBody,
  handler: async ({ request, body, authz: routeAuthz }) => {

    const gate = routeAuthz;

    const user = gate.user;

    const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(requestId)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }




    try {
      const result = await createManualJournal({
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        idempotencyKey: requestId,
        body: body,
      });
      return NextResponse.json(result.journal, { status: result.created ? 201 : 200 });
    } catch (error) {
      if (error instanceof JournalCreateError) {
        return NextResponse.json(error.toJson(), { status: error.status });
      }
      throw error;
    }
  },
});
