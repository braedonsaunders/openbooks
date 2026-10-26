import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  rejectAssetProposal,
  restoreAssetProposal,
} from "@openbooks/engine/assets/asset-proposals";
import { id, reasonText, scopeOf } from "../../_depth";

export const runtime = "nodejs";

const body = z.strictObject({
  action: z.enum(["reject", "restore"]),
  reason: reasonText,
});

/** Reject a pending proposal with a reason, or return a rejected one to the queue. */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "assetProposals",
  params: z.object({ id }),
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: proposalId } = await params;
    const args = {
      proposalId,
      reason: input.reason,
      actorId: gate.user.id,
      allowedSubsidiaryIds: scopeOf(gate),
    };
    if (input.action === "reject") await rejectAssetProposal(gate.user.orgId, args);
    else await restoreAssetProposal(gate.user.orgId, args);
    return NextResponse.json({ ok: true });
  },
});
