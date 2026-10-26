import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { readPosReceipt } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";

export const runtime = "nodejs";

/** GET /api/pos/receipts/[id] — a register receipt with its lines, tenders, change and refundable quantities. */
export const GET = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json({
        receipt: await readPosReceipt(
          db,
          authz.user.orgId,
          params.id,
          authz.allowedSubsidiaryIds ?? null,
        ),
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
