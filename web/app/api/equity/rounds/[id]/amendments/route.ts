import { NextResponse } from "next/server";
import { z } from "zod";
import { amendRound } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { idempotencyKey, optionalDecimal, reason } from "../../../_schema";

export const runtime = "nodejs";

const params = z.object({ id: uuidId });
const body = z.object({
  effectiveOn: isoDate(),
  name: z.string().trim().min(1).max(200).nullable().optional(),
  pricePerShare: optionalDecimal,
  preMoneyValuation: optionalDecimal,
  preMoneyBasisReason: z.string().trim().max(2000).nullable().optional(),
  reason,
  idempotencyKey,
});

/**
 * Amend a recorded round's name, price or pre-money valuation (equity.manage).
 * The amendment is submitted to any enabled Equity action Flow: it applies at
 * once (201) when no Flow gates it, and otherwise waits for the Flow's
 * decision (202, status pending_approval).
 */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  params,
  invalidParamsNotFound: "record",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await amendRound({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      roundId: id,
      ...body,
    });
    return NextResponse.json(result, {
      status: result.replayed ? 200 : result.status === "pending_approval" ? 202 : 201,
    });
  },
});
