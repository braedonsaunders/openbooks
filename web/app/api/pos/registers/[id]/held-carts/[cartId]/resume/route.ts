import { z } from "zod";
import { NextResponse } from "next/server";
import { resumeHeldCart } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";

export const runtime = "nodejs";

/** POST /api/pos/registers/[id]/held-carts/[cartId]/resume — take a held cart back into the register, removing it exactly once. */
export const POST = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  params: z.object({ id: uuidId, cartId: uuidId }),
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json({
        cart: await resumeHeldCart(
          authz.user.orgId,
          params.id,
          params.cartId,
          authz.allowedSubsidiaryIds ?? null,
        ),
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
