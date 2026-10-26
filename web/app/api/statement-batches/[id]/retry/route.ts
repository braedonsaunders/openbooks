import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { enqueueStatementBatchJobs } from "@openbooks/jobs";
import { retryStatementBatchRun } from "@openbooks/engine/receivables/statement-batches";
import { can } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Retry a batch run: failed (and never-attempted queued) items re-arm and
 * their jobs enqueue again — the deterministic job identity dedupes the
 * ones already live, and already-sent customers never transmit again.
 */
export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = params;
    if (!can(gate, "ar.create"))
      return NextResponse.json({ error: "missing permission: ar.create" }, { status: 403 });
    if (!can(gate, "ar.read"))
      return NextResponse.json({ error: "missing permission: ar.read" }, { status: 403 });
    if (!can(gate, "reports.read"))
      return NextResponse.json({ error: "missing permission: reports.read" }, { status: 403 });
    if (!isUuid(id)) return notFound("record");
    try {
      const result = await retryStatementBatchRun(
        gate.user.orgId,
        id,
        gate.user.id,
        (jobs) => enqueueStatementBatchJobs(jobs),
        gate.allowedSubsidiaryIds,
      );
      return NextResponse.json({ ok: true, requeued: result.requeued });
    } catch (e) {
      if (e instanceof Error && /was not found/.test(e.message)) return notFound("record");
      return apiErrorResponse(e);
    }
  },
});
