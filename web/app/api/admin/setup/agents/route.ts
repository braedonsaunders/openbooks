import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import type { Authz } from "@/lib/authz";
import { getAgentsOverview } from "@/lib/setup/agents";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/setup/agents — one overview row per registered pack (policy,
 * last run, open findings). Setup managers only; the provider page keeps its
 * own read path.
 */
async function legacyGET(gate: Authz) {
  return NextResponse.json({ agents: await getAgentsOverview(gate.user.orgId) });
}

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Agent policy administration is available to setup managers before optional agent capabilities are enabled.",
  },
  handler: async ({ authz }) => legacyGET(authz),
});
