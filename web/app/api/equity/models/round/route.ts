import { NextResponse } from "next/server";
import { z } from "zod";
import { modelEntityRound } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { decimalText, optionalDecimal } from "../../_schema";

export const runtime = "nodejs";

const body = z.object({
  subsidiaryId: uuidId,
  asOf: isoDate(),
  preMoneyValuation: decimalText,
  investment: decimalText,
  targetPoolPercent: optionalDecimal,
});

/** Model a priced round against the cap table: price, conversions, pool top-up and dilution. Nothing is recorded. */
export const POST = defineRoute({
  permission: "equity.read",
  feature: "equity",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await modelEntityRound({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...body,
        targetPoolPercent: body.targetPoolPercent ?? null,
      }),
    ),
});
