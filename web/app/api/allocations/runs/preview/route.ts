import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../lib/api/json";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import { previewAllocationRun } from "../../../../../../engine/src/allocations/period-run.ts";
import { allocationServiceDeps } from "../../../../../../engine/src/allocations/service.ts";
import { previewPinError } from "../../../../../../engine/src/allocations/subsidiary-scope.ts";
import { isUuid } from "../../../../../lib/list-params";
import { allocationRunErrorResponse } from "../../_lib.ts";

export const runtime = "nodejs";

const previewBodySchema = z.object({
  ruleId: z.string(),
  periodId: z.string(),
  bookId: z.string(),
  subsidiaryId: z.string().nullable().optional(),
});

/**
 * Run preview (A8): rule + period + book (+ subsidiary) → the full
 * RunComputation, PERSISTED as a `previewed` run row plus an audit entry —
 * preview writes no GL journal, but it does write the run. `allocations.run`.
 * A subsidiary-restricted caller must pin a visible subsidiary: an omitted
 * pin would sweep every legal entity.
 */
export async function POST(req: Request) {
  const gate = await guardAllocations("allocations.run");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, previewBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const data = parsedBody.data;
  for (const [name, value] of [
    ["ruleId", data.ruleId],
    ["periodId", data.periodId],
    ["bookId", data.bookId],
  ] as const) {
    if (!isUuid(value)) return NextResponse.json({ error: `${name} must be a uuid` }, { status: 400 });
  }
  if (data.subsidiaryId != null && !isUuid(data.subsidiaryId)) {
    return NextResponse.json({ error: "subsidiaryId must be a uuid" }, { status: 400 });
  }
  const pinRefusal = previewPinError(gate.allowedSubsidiaryIds, data.subsidiaryId ?? null);
  if (pinRefusal) {
    return NextResponse.json({ error: pinRefusal }, { status: 403 });
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
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      allocationServiceDeps(),
    );
    return NextResponse.json({ computation: run.computation });
  } catch (error) {
    return allocationRunErrorResponse(error, "Unable to preview the allocation run.");
  }
}
