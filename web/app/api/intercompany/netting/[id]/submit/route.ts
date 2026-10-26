import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { submitNettingRun } from "@openbooks/engine/intercompany";
import { idParams } from "../../../_schema";

export const runtime = "nodejs";

/**
 * Submit a proposed run. An enabled approval flow parks it pending approval;
 * with none configured the run is approved at once.
 */
export const POST = defineRoute({
  permission: "intercompany.manage",
  feature: "intercompanyNetting",
  params: idParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await submitNettingRun(
        authz.user.orgId,
        authz.user.id,
        params.id,
        authz.allowedSubsidiaryIds,
      ),
    ),
});
