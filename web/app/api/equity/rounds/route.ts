import { NextResponse } from "next/server";
import { z } from "zod";
import { createRound } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { currencyCode, decimalText } from "../_schema";

export const runtime = "nodejs";

const body = z.object({
  subsidiaryId: uuidId,
  name: z.string().trim().min(1).max(200),
  shareClassId: uuidId,
  closedOn: isoDate(),
  pricePerShare: decimalText,
  preMoneyValuation: decimalText,
  currency: currencyCode.nullable().optional(),
  preMoneyBasisReason: z.string().trim().max(2000).nullable().optional(),
});

/** Record a closed financing round; its shares and conversions are then recorded against it. */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await createRound({ orgId: authz.user.orgId, actorId: authz.user.id, ...body }),
      { status: 201 },
    ),
});
