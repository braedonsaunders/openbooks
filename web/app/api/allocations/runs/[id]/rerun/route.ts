import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateCan, guardAllocations, missingPermission } from "@/lib/allocations-gate";
import { requireVisibleAllocationRun } from "../../../../../../lib/allocations-scope";
import { isUuid } from "@/lib/list-params";
import { rerunAllocationRun } from "@openbooks/engine/allocations/period-run";
import { allocationRunErrorResponse } from "../../../_lib.ts";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const rerunBodySchema = z.object({
  reason: z.string().min(5).max(500).optional(),
  reversalDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Re-run (A8): reverse the posted run and compute a fresh one.
 * `allocations.run` + `gl.post`. An explicit reason is recorded in the
 * audit log; callers without one get the request's provenance.
 */
async function legacyPOST(
  id: string,
  body: z.output<typeof rerunBodySchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;

  // The Runs tab always posts a JSON object (`{}` for a one-click re-run);
  // an explicit reason/reversalDate travel in it when the caller has one.
  const reason = body.reason?.trim() || "Re-run requested from the Runs tab";
  const reversalDate = body.reversalDate;
  try {
    const { run } = await rerunAllocationRun(id, gate.user.id, reason, { reversalDate });
    return NextResponse.json({ runId: run.id });
  } catch (error) {
    return allocationRunErrorResponse(error, "Unable to re-run the allocation run.");
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
  body: rerunBodySchema,
  opaque: {
    reason: "An omitted reason uses the route's existing default audit reason.",
    reversalDate: "An omitted date lets the run service select its existing default date.",
  },
  handler: ({ params, authz, body }) => legacyPOST(params.id, body, authz),
});
