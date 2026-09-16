import { NextResponse } from "next/server";
import { gateCan, guardAllocations, missingPermission } from "../../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../../lib/list-params";
import {
  ENGINE_PENDING,
  EnginePendingError,
  getPeriodRunEngine,
} from "../../../../../../../engine/src/allocations/a8-shims.ts";

export const runtime = "nodejs";

function pending(error: EnginePendingError): NextResponse {
  return NextResponse.json(
    { errorCode: ENGINE_PENDING, owner: error.ownerShard, detail: error.message },
    { status: 503 },
  );
}

type Ctx = { params: Promise<{ id: string }> };

/**
 * Re-run (A8): reverse the posted run and compute a fresh one.
 * `allocations.run` + `gl.post`. Until A3 lands, `engine_pending`.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.run");
  if (gate instanceof NextResponse) return gate;
  if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const result = await getPeriodRunEngine().rerun({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      runId: id,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EnginePendingError) return pending(error);
    throw error;
  }
}
