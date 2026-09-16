import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../../lib/api/json";
import { gateCan, guardAllocations, missingPermission } from "../../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../../lib/list-params";
import { postAllocationRun } from "../../../../../../../engine/src/allocations/period-run.ts";

export const runtime = "nodejs";

const reasonBodySchema = z.object({ reason: z.string().min(1).max(2000) });

type Ctx = { params: Promise<{ id: string }> };

/**
 * Post a previewed run (A8). `allocations.run` + `gl.post`; the reason
 * prompt in the UI is mandatory here, not cosmetic.
 */
export async function POST(req: Request, { params }: Ctx) {
  const gate = await guardAllocations("allocations.run");
  if (gate instanceof NextResponse) return gate;
  if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsedBody = await parseJsonBody(req, reasonBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const run = await postAllocationRun(id, gate.user.id, parsedBody.data.reason.trim());
  return NextResponse.json({ runId: run.id, journalEntryId: run.journalEntryId });
}
