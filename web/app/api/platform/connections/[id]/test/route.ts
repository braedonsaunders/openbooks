import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { testConnectionAction } from "@/lib/sync/connection-admin-actions";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Test a connection's credentials and persist the probe outcome onto that
 * same version of the row (status / last_error). Probe target and version
 * token come from one read; a concurrent change leaves the new row untouched.
 */
export const POST = defineRoute({
  permission: "sync.run",
  feature: {
    none: "Connection probes are controlled by sync-run permission and have no separate organization feature gate.",
  },
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  handler: async ({ params: { id }, authz: gate }) => {
    // Probing a connection exercises its credentials the way a run does, so
    // it rides the `sync.run` grant beside the run route; reconfiguring the
    // connection itself stays `admin.setup.manage`.
    const result = await testConnectionAction(gate.user.orgId, id);
    return NextResponse.json(result.body, { status: result.status });
  },
});
