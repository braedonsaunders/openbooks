import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { postIntercompanyFundTransfer } from "@openbooks/engine/intercompany";
import { transferBody } from "../_schema";

export const runtime = "nodejs";

/**
 * Move cash between two entities' bank accounts. The posting adds the pair's
 * due-to/due-from legs so each entity balances on its own. Idempotent per key.
 */
export const POST = defineRoute({
  permission: "intercompany.settle",
  feature: "intercompanyNetting",
  body: transferBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const transfer = await postIntercompanyFundTransfer(
      authz.user.orgId,
      authz.user.id,
      authz.allowedSubsidiaryIds,
      body,
    );
    return NextResponse.json(transfer, { status: 201 });
  },
});
