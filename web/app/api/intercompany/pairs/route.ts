import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { linkIntercompanyDocuments } from "@openbooks/engine/intercompany";
import { linkPairBody } from "../_schema";

export const runtime = "nodejs";

/** Link an intercompany sales document to its purchase counterpart, with a reason. */
export const POST = defineRoute({
  permission: "intercompany.manage",
  feature: "intercompanyTransactions",
  body: linkPairBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const pair = await linkIntercompanyDocuments(
      authz.user.orgId,
      authz.user.id,
      authz.allowedSubsidiaryIds,
      {
        sellerDocumentId: body.sellerDocumentId,
        buyerDocumentId: body.buyerDocumentId,
        reason: body.reason,
        origin: "linked",
      },
    );
    return NextResponse.json(pair, { status: 201 });
  },
});
