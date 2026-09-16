import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import {
  ENGINE_PENDING,
  EnginePendingError,
  getPeriodRunEngine,
} from "../../../../../../engine/src/allocations/a8-shims.ts";

export const runtime = "nodejs";

const previewBodySchema = z.object({
  ruleId: z.string(),
  periodId: z.string(),
  bookId: z.string(),
  subsidiaryId: z.string().nullable().optional(),
});

function pending(error: EnginePendingError): NextResponse {
  return NextResponse.json(
    { errorCode: ENGINE_PENDING, owner: error.ownerShard, detail: error.message },
    { status: 503 },
  );
}

/**
 * Run preview (A8): rule + period + book (+ subsidiary) → the full
 * RunComputation without writing anything. `allocations.run`. Until A3
 * lands, the engine seam answers `engine_pending` (HTTP 503).
 */
export async function POST(req: Request) {
  const gate = await guardAllocations("allocations.run");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, previewBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const data = parsedBody.data;
  if (data.subsidiaryId != null && gate.allowedSubsidiaryIds !== null && !gate.allowedSubsidiaryIds.has(data.subsidiaryId)) {
    return NextResponse.json({ error: "subsidiary outside the caller's scope" }, { status: 403 });
  }
  try {
    const computation = await getPeriodRunEngine().preview({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      ruleId: data.ruleId,
      periodId: data.periodId,
      bookId: data.bookId,
      subsidiaryId: data.subsidiaryId,
      triggerKind: "manual",
    });
    return NextResponse.json({ computation });
  } catch (error) {
    if (error instanceof EnginePendingError) return pending(error);
    throw error;
  }
}
