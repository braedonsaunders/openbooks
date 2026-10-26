import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { previewAllocationRun } from "@openbooks/engine/allocations/period-run";
import { allocationServiceDeps } from "@openbooks/engine/allocations/service";
import { previewPinError } from "@openbooks/engine/organization/allocation-scope";
import { isUuid } from "@/lib/list-params";
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
export const POST = defineRoute({
  permission: "allocations.run",
  feature: "allocations",
  body: previewBodySchema,
  handler: async ({ authz: gate, body: data }) => {
    for (const [name, value] of [
      ["ruleId", data.ruleId],
      ["periodId", data.periodId],
      ["bookId", data.bookId],
    ] as const) {
      if (!isUuid(value))
        return NextResponse.json({ error: `${name} must be a uuid` }, { status: 400 });
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
    // Fail-closed computation errors answer 404/422 with the message
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
  },
});
