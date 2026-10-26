import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { unlinkIntercompanyPair } from "@openbooks/engine/intercompany";
import { idParams, reasonBody } from "../../../_schema";

export const runtime = "nodejs";

/** End a pair with a reason; the pair stays in history. */
export const POST = defineRoute({
  permission: "intercompany.manage",
  feature: "intercompanyTransactions",
  params: idParams,
  body: reasonBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await unlinkIntercompanyPair(
        authz.user.orgId,
        authz.user.id,
        authz.allowedSubsidiaryIds,
        params.id,
        body.reason,
      ),
    ),
});
