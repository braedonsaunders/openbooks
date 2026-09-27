import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../../lib/api/json";
import { gateCan, missingPermission } from "../../../../../../lib/allocations-gate";
import { requireVisibleAllocationRun } from "../../../../../../lib/allocations-scope";
import { isUuid } from "../../../../../../lib/list-params";
import { rerunAllocationRun } from "../../../../../../../engine/src/allocations/period-run.ts";
import { allocationRunErrorResponse } from "../../../_lib.ts";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

const rerunBodySchema = z.object({
  reason: z.string().min(5).max(500).optional(),
  reversalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Re-run (A8): reverse the posted run and compute a fresh one.
 * `allocations.run` + `gl.post`. An explicit reason is recorded in the
 * audit log; callers without one get the request's provenance.
 */
async function legacyPOST(req: Request, { params }: Ctx, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const scoped = await requireVisibleAllocationRun(gate.user.orgId, id, gate.allowedSubsidiaryIds);
  if (scoped instanceof NextResponse) return scoped;
  // The Runs tab always posts a JSON object (`{}` for a one-click re-run);
  // an explicit reason/reversalDate travel in it when the caller has one.
  const parsedBody = await parseJsonBody(req, rerunBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const reason = parsedBody.data.reason?.trim() || "Re-run requested from the Runs tab";
  const reversalDate = parsedBody.data.reversalDate;
  try {
    const { run } = await rerunAllocationRun(id, gate.user.id, reason, { reversalDate });
    return NextResponse.json({ runId: run.id });
  } catch (error) {
    return allocationRunErrorResponse(error, "Unable to re-run the allocation run.");
  }
}

export const POST = defineRoute({
  permission: "allocations.run", feature: "allocations",
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
