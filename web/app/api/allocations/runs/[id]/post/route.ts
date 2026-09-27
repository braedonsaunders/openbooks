import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "../../../../../../lib/api/json";
import { gateCan, missingPermission } from "../../../../../../lib/allocations-gate";
import { requireVisibleAllocationRun } from "../../../../../../lib/allocations-scope";
import { isUuid } from "../../../../../../lib/list-params";
import { postAllocationRun } from "../../../../../../../engine/src/allocations/period-run.ts";
import { allocationRunErrorResponse } from "../../../_lib.ts";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

const reasonBodySchema = z.object({ reason: z.string().min(1).max(2000) });

type Ctx = { params: Promise<{ id: string }> };

/**
 * Post a previewed run (A8; A14 approval flows). `allocations.run` +
 * `gl.post`; the reason prompt in the UI is mandatory here, not cosmetic.
 * When the run's version names an approval flow the run is NOT posted: the
 * flow opens and the route answers 202 with the flow run id — the run waits
 * in pending_approval until the flow approves.
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
    const run = await postAllocationRun(id, gate.user.id, parsedBody.data.reason.trim());
    if (run.status === "pending_approval") {
      return NextResponse.json(
        { runId: run.id, status: run.status, flowRunId: run.flowRunId, journalEntryId: null },
        { status: 202 },
      );
    }
    return NextResponse.json({ runId: run.id, status: run.status, journalEntryId: run.journalEntryId });
  } catch (error) {
    return allocationRunErrorResponse(error, "Unable to post the allocation run.");
  }
}

export const POST = defineRoute({
  permission: "allocations.run", feature: "allocations",
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
