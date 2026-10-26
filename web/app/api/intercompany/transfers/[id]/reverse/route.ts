import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { reverseIntercompanyFundTransfer } from "@openbooks/engine/intercompany";
import { idParams, reversalBody } from "../../../_schema";

export const runtime = "nodejs";

/** Reverse a posted transfer on a date with a reason. */
export const POST = defineRoute({
  permission: "intercompany.settle",
  feature: "intercompanyNetting",
  params: idParams,
  body: reversalBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await reverseIntercompanyFundTransfer(
        authz.user.orgId,
        authz.user.id,
        params.id,
        body,
        authz.allowedSubsidiaryIds,
      ),
    ),
});
