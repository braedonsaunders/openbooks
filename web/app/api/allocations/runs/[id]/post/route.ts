import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateCan, guardAllocations, missingPermission } from "@/lib/allocations-gate";
import { requireVisibleAllocationRun } from "@/lib/allocations-scope";
import { isUuid } from "../../../../../../lib/list-params";
import { postAllocationRun } from "@openbooks/engine/allocations/period-run";
import { allocationRunErrorResponse } from "../../../_lib.ts";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const reasonBodySchema = z.object({ reason: z.string().min(1).max(2000) });

/**
 * Post a previewed run (A8; A14 approval flows). `allocations.run` +
 * `gl.post`; the reason prompt in the UI is mandatory here, not cosmetic.
 * When the run's version names an approval flow the run is NOT posted: the
 * flow opens and the route answers 202 with the flow run id — the run waits
 * in pending_approval until the flow approves.
 */
async function legacyPOST(
  id: string,
  body: z.output<typeof reasonBodySchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;

  try {
    const run = await postAllocationRun(id, gate.user.id, body.reason.trim());
    if (run.status === "pending_approval") {
      return NextResponse.json(
        { runId: run.id, status: run.status, flowRunId: run.flowRunId, journalEntryId: null },
        { status: 202 },
      );
    }
    return NextResponse.json({
      runId: run.id,
      status: run.status,
      journalEntryId: run.journalEntryId,
    });
  } catch (error) {
    return allocationRunErrorResponse(error, "Unable to post the allocation run.");
  }
}

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const gate = await guardAllocations("allocations.run");
    if (gate instanceof NextResponse) return gate;
    if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    return requireVisibleAllocationRun(gate.user.orgId, id, gate.allowedSubsidiaryIds).then(
      (scoped) => (scoped instanceof NextResponse ? scoped : gate),
    );
  },
  feature: "allocations",
  params: z.object({ id: z.string() }),
  body: reasonBodySchema,
  handler: ({ params, authz, body }) => legacyPOST(params.id, body, authz),
});
