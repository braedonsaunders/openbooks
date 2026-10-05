import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError, approvePayoutSuggestion } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

/**
 * Link the approved candidate document to the settlement line. The body
 * names a candidate rank, never a target: the engine recomputes the
 * proposal and refuses a rank it did not offer. Similar lines each get
 * their own top-ranked link, never this line's document.
 */
export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  params: z.object({ id: z.string() }),
  body: z.strictObject({ rank: z.number().int().min(0).max(20), applyToSimilar: z.boolean() }),
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    try {
      // The caller's scope is explicit (never defaulted): approval discovers
      // and writes under it, and an unknown scope fails closed in the engine.
      return NextResponse.json(
        await approvePayoutSuggestion(gate.user.orgId, gate.user.id, id, {
          rank: body.rank,
          applyToSimilar: body.applyToSimilar,
        }, gate.allowedSubsidiaryIds),
      );
    } catch (error) {
      if (error instanceof CommerceError && error.code === "payout_line_unknown") return notFound("record");
      throw error;
    }
  },
});
