import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { linkCipCosts, unlinkCipCost } from "@openbooks/engine/assets/asset-cip";
import { id, reasonText, scopeOf } from "../../../_depth";

export const runtime = "nodejs";

const body = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("link"),
    journalLineIds: z.array(id).min(1, "choose at least one GL line").max(500),
  }),
  z.strictObject({ action: z.literal("unlink"), costId: id, reason: reasonText }),
]);

/** Link posted CIP-account lines to the record, or unlink one with a reason. */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "constructionInProgress",
  params: z.object({ id }),
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: cipAssetId } = await params;
    if (input.action === "link") {
      return NextResponse.json(
        await linkCipCosts(gate.user.orgId, {
          cipAssetId,
          journalLineIds: input.journalLineIds,
          actorId: gate.user.id,
          allowedSubsidiaryIds: scopeOf(gate),
        }),
      );
    }
    return NextResponse.json(
      await unlinkCipCost(gate.user.orgId, {
        costId: input.costId,
        reason: input.reason,
        actorId: gate.user.id,
        allowedSubsidiaryIds: scopeOf(gate),
      }),
    );
  },
});
