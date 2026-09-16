import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../../lib/api/json";
import { gateCan, guardAllocations, missingPermission } from "../../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../../lib/list-params";
import { rerunAllocationRun } from "../../../../../../../engine/src/allocations/period-run.ts";

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
export async function POST(req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.run");
  if (gate instanceof NextResponse) return gate;
  if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  // The Runs tab always posts a JSON object (`{}` for a one-click re-run);
  // an explicit reason/reversalDate travel in it when the caller has one.
  const parsedBody = await parseJsonBody(req, rerunBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const reason = parsedBody.data.reason?.trim() || "Re-run requested from the Runs tab";
  const reversalDate = parsedBody.data.reversalDate;
  const { run } = await rerunAllocationRun(id, gate.user.id, reason, { reversalDate });
  return NextResponse.json({ runId: run.id });
}
