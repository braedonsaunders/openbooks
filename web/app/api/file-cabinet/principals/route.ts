import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { listFileCabinetPrincipals } from "@openbooks/engine/records/file-cabinet-access";

export const runtime = "nodejs";

/**
 * Users + roles in the org, for the sharing principal picker. Gated by
 * documents.read (a Manager may not be an org admin, so this avoids the
 * admin-only user/role APIs) and returns only id + display name.
 */
export const GET = defineRoute({
  permission: "documents.read",
  feature: {
    none: "This documents surface is governed by its permission and has no separate organization feature switch.",
  },
  handler: async ({ authz: gate }) => {
    return NextResponse.json(await listFileCabinetPrincipals(gate.user.orgId));
  },
});
