import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../../lib/api/json";
import { gateCan, guardAllocations, missingPermission } from "../../../../../../lib/allocations-gate";
import { isUuid } from "../../../../../../lib/list-params";
import { reverseAllocationRun } from "../../../../../../../engine/src/allocations/period-run.ts";
import { allocationRunErrorResponse } from "../../../_lib.ts";

export const runtime = "nodejs";

const reasonBodySchema = z.object({
  reason: z.string().min(1).max(2000),
  // Defaults to the business day (the open current period). Tests and
  // backdated corrections pass an explicit ISO date instead.
  reversalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Reverse a posted run (A8). `allocations.run` + `gl.post`; mirrors the
 * stored lines, never recomputes.
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
    const run = await reverseAllocationRun(id, gate.user.id, parsedBody.data.reason.trim(), {
      reversalDate: parsedBody.data.reversalDate,
    });
    return NextResponse.json({ reversalEntryId: run.reversalEntryId });
  } catch (error) {
    return allocationRunErrorResponse(error, "Unable to reverse the allocation run.");
  }
}
