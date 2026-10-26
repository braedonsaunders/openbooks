import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { previewNetting } from "@openbooks/engine/intercompany";
import { nettingBody } from "../../_schema";

export const runtime = "nodejs";

/** What a netting run would settle, computed exactly as a proposal is, without writing. */
export const POST = defineRoute({
  permission: "intercompany.manage",
  feature: "intercompanyNetting",
  body: nettingBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(await previewNetting(authz.user.orgId, authz.allowedSubsidiaryIds, body)),
});
