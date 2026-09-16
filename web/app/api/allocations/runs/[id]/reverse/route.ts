import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../../lib/api/json";
import { gateCan, guardAllocations, missingPermission } from "../../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../../lib/list-params";
import {
  ENGINE_PENDING,
  EnginePendingError,
  getPeriodRunEngine,
} from "../../../../../../../engine/src/allocations/a8-shims.ts";

export const runtime = "nodejs";

const reasonBodySchema = z.object({ reason: z.string().min(1).max(2000) });

function pending(error: EnginePendingError): NextResponse {
  return NextResponse.json(
    { errorCode: ENGINE_PENDING, owner: error.ownerShard, detail: error.message },
    { status: 503 },
  );
}

type Ctx = { params: Promise<{ id: string }> };

/**
 * Reverse a posted run (A8). `allocations.run` + `gl.post`; mirrors the
 * stored lines, never recomputes. Until A3 lands, `engine_pending`.
 */
export async function POST(req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.run");
  if (gate instanceof NextResponse) return gate;
  if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsedBody = await parseJsonBody(req, reasonBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const result = await getPeriodRunEngine().reverse({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      runId: id,
      reason: parsedBody.data.reason.trim(),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EnginePendingError) return pending(error);
    throw error;
  }
}
