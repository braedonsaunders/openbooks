import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { loadIntercompanyPairDetail } from "@openbooks/engine/intercompany";
import { idParams } from "../../_schema";

export const runtime = "nodejs";

/** One pair with both documents and their comparison. */
export const GET = defineRoute({
  permission: "intercompany.read",
  feature: "intercompanyTransactions",
  params: idParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await loadIntercompanyPairDetail(authz.user.orgId, params.id, authz.allowedSubsidiaryIds),
    ),
});
