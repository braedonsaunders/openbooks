import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { cancelNettingRun } from "@openbooks/engine/intercompany";
import { idParams, reasonBody } from "../../../_schema";

export const runtime = "nodejs";

/** Cancel a run that has not posted, with a reason. */
export const POST = defineRoute({
  permission: "intercompany.manage",
  feature: "intercompanyNetting",
  params: idParams,
  body: reasonBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await cancelNettingRun(
        authz.user.orgId,
        authz.user.id,
        params.id,
        body.reason,
        authz.allowedSubsidiaryIds,
      ),
    ),
});
