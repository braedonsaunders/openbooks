import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import type { Authz } from "@/lib/authz";
import { listAgentRuns } from "@/lib/setup/agents";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/setup/agents/activity — run envelopes across packs, newest
 * first (`?agent=` filters to one pack, `?limit=` caps the list). Setup
 * managers only.
 */
async function legacyGET(request: Request, gate: Authz) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const result = await listAgentRuns(gate.user.orgId, {
    agentKey: url.searchParams.get("agent") ?? undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return NextResponse.json(result);
}

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Agent run history remains available to setup managers when optional agent capabilities are disabled.",
  },
  handler: async ({ request, authz }) => legacyGET(request, authz),
});
