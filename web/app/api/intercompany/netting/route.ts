import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { proposeNettingRun } from "@openbooks/engine/intercompany";
import { nettingBody } from "../_schema";

export const runtime = "nodejs";

/** Propose a netting run: the stored, fingerprinted proposal that is approved and posted. */
export const POST = defineRoute({
  permission: "intercompany.manage",
  feature: "intercompanyNetting",
  body: nettingBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const run = await proposeNettingRun(
      authz.user.orgId,
      authz.user.id,
      authz.allowedSubsidiaryIds,
      body,
    );
    return NextResponse.json(run, { status: 201 });
  },
});
