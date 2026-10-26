import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateCan, guardAllocations, missingPermission } from "@/lib/allocations-gate";
import { requireVisibleAllocationRun } from "@/lib/allocations-scope";
import { isUuid } from "../../../../../../lib/list-params";
import { reverseAllocationRun } from "@openbooks/engine/allocations/period-run";
import { allocationRunErrorResponse } from "../../../_lib.ts";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const reasonBodySchema = z.object({
  reason: z.string().min(1).max(2000),
  // Defaults to the business day (the open current period). Tests and
  // backdated corrections pass an explicit ISO date instead.
  reversalDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Reverse a posted run (A8). `allocations.run` + `gl.post`; mirrors the
 * stored lines, never recomputes.
 */
async function legacyPOST(
  id: string,
  body: z.output<typeof reasonBodySchema>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;

  try {
    const run = await reverseAllocationRun(id, gate.user.id, body.reason.trim(), {
      reversalDate: body.reversalDate,
    });
    return NextResponse.json({ reversalEntryId: run.reversalEntryId });
  } catch (error) {
    return allocationRunErrorResponse(error, "Unable to reverse the allocation run.");
  }
}

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const gate = await guardAllocations("allocations.run");
    if (gate instanceof NextResponse) return gate;
    if (!gateCan(gate, "gl.post")) return missingPermission("gl.post");
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    return requireVisibleAllocationRun(gate.user.orgId, id, gate.allowedSubsidiaryIds).then(
      (scoped) => (scoped instanceof NextResponse ? scoped : gate),
    );
  },
  feature: "allocations",
  params: z.object({ id: z.string() }),
  body: reasonBodySchema,
  handler: ({ params, authz, body }) => legacyPOST(params.id, body, authz),
});
