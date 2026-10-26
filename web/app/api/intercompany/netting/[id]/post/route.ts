import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { postNettingRun } from "@openbooks/engine/intercompany";
import { idParams } from "../../../_schema";

export const runtime = "nodejs";

/** Post an approved run exactly as proposed; refuses if any balance changed. Idempotent. */
export const POST = defineRoute({
  permission: "intercompany.settle",
  feature: "intercompanyNetting",
  params: idParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await postNettingRun(authz.user.orgId, authz.user.id, params.id, authz.allowedSubsidiaryIds),
    ),
});
