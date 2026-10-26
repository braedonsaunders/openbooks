import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { defineRoute } from "../../../../../lib/api/route";
import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";
import { RunQueryError, getRun } from "@openbooks/engine/allocations/run-queries";
import { allocationScopeVisible } from "@openbooks/engine/organization/allocation-scope";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Run detail drawer payload: the stored RunComputation plus its journal links. */
export const GET = defineRoute({
  permission: "allocations.read",
  feature: "allocations",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = params;
    if (!isUuid(id)) return notFound("record");
    try {
      const run = await getRun(gate.user.orgId, id);
      // Full computation scope, not just the pin: a pinned run whose targets
      // cross into a hidden subsidiary stays invisible to restricted callers.
      if (!allocationScopeVisible(gate.allowedSubsidiaryIds, run.subsidiaryId, run.computation)) {
        return notFound("record");
      }
      return NextResponse.json({ run });
    } catch (error) {
      if (error instanceof RunQueryError) {
        return apiErrorResponse(error);
      }
      throw error;
    }
  },
});
