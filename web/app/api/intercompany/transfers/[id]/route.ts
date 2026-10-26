import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { loadIntercompanyFundTransfer } from "@openbooks/engine/intercompany";
import { idParams } from "../../_schema";

export const runtime = "nodejs";

/** One transfer between entities; visible only when both entities are in scope. */
export const GET = defineRoute({
  permission: "intercompany.read",
  feature: "intercompanyNetting",
  params: idParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await loadIntercompanyFundTransfer(authz.user.orgId, params.id, authz.allowedSubsidiaryIds),
    ),
});
