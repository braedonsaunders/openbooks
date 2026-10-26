import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { proposeJournalLine, scanAssetProposals } from "@openbooks/engine/assets/asset-proposals";
import { calendarDate, id, scopeOf } from "../../_depth";

export const runtime = "nodejs";

const body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("scan"), from: calendarDate("from"), to: calendarDate("to") }),
  z.strictObject({
    action: z.literal("line"),
    journalLineId: id,
    categoryId: id.nullable().optional(),
  }),
]);

/**
 * Propose assets on demand: scan a posting-date window under the active
 * capitalization rules, or propose one posted GL line no rule covers.
 */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "assetProposals",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: input }) => {
    if (input.action === "scan") {
      return NextResponse.json(
        await scanAssetProposals(gate.user.orgId, {
          from: input.from,
          to: input.to,
          actorId: gate.user.id,
        }),
      );
    }
    const result = await proposeJournalLine(gate.user.orgId, {
      journalLineId: input.journalLineId,
      categoryId: input.categoryId ?? null,
      actorId: gate.user.id,
      allowedSubsidiaryIds: scopeOf(gate),
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  },
});
