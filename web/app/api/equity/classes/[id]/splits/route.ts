import { NextResponse } from "next/server";
import { z } from "zod";
import { recordSplit } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { reason, wholeShares } from "../../../_schema";

export const runtime = "nodejs";

const params = z.object({ id: uuidId });
const body = z.object({
  effectiveOn: isoDate(),
  ratioNumerator: wholeShares,
  ratioDenominator: wholeShares,
  reason,
});

/**
 * Record a stock split of a class (equity.manage); it restates holdings and
 * prices from its date and adjusts the conversion price of every preferred
 * class converting into it under adjusting terms. It is submitted to any enabled Equity action Flow: it applies at once (201)
 * when no Flow gates it, and otherwise waits for the Flow's decision (202,
 * status pending_approval).
 */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  params,
  invalidParamsNotFound: "record",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await recordSplit({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      shareClassId: id,
      ...body,
    });
    return NextResponse.json(result, { status: result.status === "pending_approval" ? 202 : 201 });
  },
});
