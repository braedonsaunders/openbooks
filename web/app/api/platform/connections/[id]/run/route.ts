import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requestConnectionRun } from "@/lib/sync/connection-run";

export const runtime = "nodejs";

/**
 * Enqueue a migration or mirror pass for this connection onto the worker.
 * Returns immediately with the job id; progress lands in the sync_runs table
 * the platform page renders.
 */
const runBody = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.enum(["full_migration", "preflight", "mirror", "project_financials", "attachments"]),
    })
    .strict(),
  z
    .object({ mode: z.literal("targeted_repair"), sourceRefs: z.array(z.string()).min(1).max(500) })
    .strict(),
]);

export const POST = defineRoute({
  permission: "sync.run",
  feature: {
    none: "Connection synchronization is controlled by sync-run permission and has no separate organization feature gate.",
  },
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  body: runBody,
  handler: async ({ params: { id }, body, authz: gate }) => {
    // Running a sync is the `sync.run` grant, not connection configuration:
    // a caller who may run but not reconfigure still passes here, while the
    // config routes keep requiring `admin.setup.manage`.
    const outcome = await requestConnectionRun(
      { orgId: gate.user.orgId, userId: gate.user.id },
      id,
      body.mode,
      body.mode === "targeted_repair" ? { sourceRefs: body.sourceRefs } : undefined,
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  },
});
