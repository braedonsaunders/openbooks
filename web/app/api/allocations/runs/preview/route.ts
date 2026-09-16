import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import { previewAllocationRun } from "../../../../../../engine/src/allocations/period-run.ts";

export const runtime = "nodejs";

const previewBodySchema = z.object({
  ruleId: z.string(),
  periodId: z.string(),
  bookId: z.string(),
  subsidiaryId: z.string().nullable().optional(),
});

/**
 * Run preview (A8): rule + period + book (+ subsidiary) → the full
 * RunComputation without writing anything. `allocations.run`.
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
  const run = await previewAllocationRun({
    orgId: gate.user.orgId,
    ruleId: data.ruleId,
    periodId: data.periodId,
    bookId: data.bookId,
    subsidiaryId: data.subsidiaryId,
    actorId: gate.user.id,
    trigger: "manual",
  });
  return NextResponse.json({ computation: run.computation });
}
