import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { loadNettingRun } from "@openbooks/engine/intercompany";
import { idParams } from "../../_schema";

export const runtime = "nodejs";

/** One netting run with its lines; visible only when every entity is in scope. */
export const GET = defineRoute({
  permission: "intercompany.read",
  feature: "intercompanyNetting",
  params: idParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await loadNettingRun(authz.user.orgId, params.id, authz.allowedSubsidiaryIds),
    ),
});
