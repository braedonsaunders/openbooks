import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError, suggestPayoutLineFix } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

/**
 * Proposed link for one unmatched settlement line. Deterministic candidates
 * with evidence always ship; approval links the chosen document.
 */
export const GET = defineRoute({
  permission: "banking.read",
  feature: "banking",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    try {
      const suggestion = await suggestPayoutLineFix(gate.user.orgId, id);
      return NextResponse.json({ suggestion });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "payout_line_unknown") return notFound("record");
      throw error;
    }
  },
});
