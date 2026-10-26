import { NextResponse } from "next/server";
import { quotePosCart } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { posQuoteBody } from "@/lib/api/pos-schemas";
import { posAuthority, posPricing } from "@/lib/pos";

export const runtime = "nodejs";

/**
 * POST /api/pos/quote — price the cart exactly as the sale will post it:
 * native selling prices, exact discount proration and the native tax on
 * each line. Writes nothing.
 */
export const POST = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  body: posQuoteBody,
  handler: async ({ authz, body }) => {
    try {
      const quote = await quotePosCart(
        {
          orgId: authz.user.orgId,
          registerId: body.registerId,
          customerId: body.customerId ?? null,
          lines: body.lines,
          orderDiscount: body.orderDiscount ?? null,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
        },
        posAuthority(authz),
        posPricing,
      );
      return NextResponse.json({ quote });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
