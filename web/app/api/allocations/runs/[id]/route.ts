import { NextResponse } from "next/server";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../lib/list-params";
import { RunQueryError, getRun } from "../../../../../../engine/src/allocations/run-queries.ts";
import { allocationScopeVisible } from "../../../../../../engine/src/allocations/subsidiary-scope.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Run detail drawer payload: the stored RunComputation plus its journal links. */
export async function GET(_req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const run = await getRun(gate.user.orgId, id);
    // Full computation scope, not just the pin: a pinned run whose targets
    // cross into a hidden subsidiary stays invisible to restricted callers.
    if (!allocationScopeVisible(gate.allowedSubsidiaryIds, run.subsidiaryId, run.computation)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (error) {
    if (error instanceof RunQueryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
