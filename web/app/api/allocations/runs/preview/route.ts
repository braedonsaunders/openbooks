import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import {
  AllocationRunError,
  previewAllocationRun,
} from "../../../../../../engine/src/allocations/period-run.ts";
import { allocationServiceDeps } from "../../../../../../engine/src/allocations/service.ts";

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
  // The production driver composition (report runner included), so
  // report_definition rules preview the same numbers a run would post.
  // Fail-closed computation errors answer 404/422 with the message (F-t06-017)
  // instead of an untyped 500 the drawer cannot render.
  try {
    const run = await previewAllocationRun(
      {
        orgId: gate.user.orgId,
        ruleId: data.ruleId,
        periodId: data.periodId,
        bookId: data.bookId,
        subsidiaryId: data.subsidiaryId,
        actorId: gate.user.id,
        trigger: "manual",
      },
      allocationServiceDeps(),
    );
    return NextResponse.json({ computation: run.computation });
  } catch (error) {
    if (error instanceof AllocationRunError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.code === "NOT_FOUND" ? 404 : 422 },
      );
    }
    console.error("Allocation preview failed", error);
    return NextResponse.json({ error: "Unable to preview the allocation run." }, { status: 500 });
  }
}
