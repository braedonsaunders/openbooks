import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../../lib/api/json";
import { gateCan, missingPermission } from "../../../../../../lib/allocations-gate";
import { requireVisibleAllocationRun } from "../../../../../../lib/allocations-scope";
import { isUuid } from "../../../../../../lib/list-params";
import { reverseAllocationRun } from "../../../../../../../engine/src/allocations/period-run.ts";
import { allocationRunErrorResponse } from "../../../_lib.ts";
import { notFound } from "@/lib/api/responses";


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
async function legacyPOST(req: Request, { params }: Ctx, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const scoped = await requireVisibleAllocationRun(gate.user.orgId, id, gate.allowedSubsidiaryIds);
  if (scoped instanceof NextResponse) return scoped;
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

export const POST = defineRoute({
  permission: "allocations.run", feature: "allocations",
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
