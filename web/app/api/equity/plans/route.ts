import { NextResponse } from "next/server";
import { z } from "zod";
import { createPlan } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { wholeShares } from "../_schema";

export const runtime = "nodejs";

const body = z.object({
  subsidiaryId: uuidId,
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  shareClassId: uuidId,
  effectiveOn: isoDate(),
  reservedShares: wholeShares,
  recycleForfeited: z.boolean(),
  recycleExpired: z.boolean(),
  recycleRepurchased: z.boolean(),
});

/** Record an equity plan and its initial reserve. */
export const POST = defineRoute({
  permission: "equity.manage",
  feature: "equity",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await createPlan({ orgId: authz.user.orgId, actorId: authz.user.id, ...body }),
      { status: 201 },
    ),
});
