import { NextResponse } from "next/server";
import { guardAllocations } from "../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../lib/list-params";
import { RunQueryError, getRun, runSubsidiaryVisible } from "../../../../../../engine/src/allocations/run-queries.ts";

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
    if (!runSubsidiaryVisible(gate.allowedSubsidiaryIds, run.subsidiaryId)) {
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
