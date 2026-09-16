import { NextResponse } from "next/server";
import { z } from "zod";
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
  // No body is the common case (the Runs tab re-runs with one click); an
  // explicit reason travels in an optional JSON body when the caller has one.
  const raw: unknown = await req.json().catch(() => undefined);
  let reason = "Re-run requested from the Runs tab";
  let reversalDate: string | undefined;
  if (raw !== undefined) {
    const parsed = rerunBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      }));
      return NextResponse.json(
        { error: issues[0]?.message ?? "invalid body", issues },
        { status: 400 },
      );
    }
    if (parsed.data.reason !== undefined) reason = parsed.data.reason.trim();
    reversalDate = parsed.data.reversalDate;
  }
  const { run } = await rerunAllocationRun(id, gate.user.id, reason, { reversalDate });
  return NextResponse.json({ runId: run.id });
}
