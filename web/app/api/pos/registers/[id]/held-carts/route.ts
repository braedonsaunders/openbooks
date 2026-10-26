import { z } from "zod";
import { NextResponse } from "next/server";
import { holdCart, listHeldCarts } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";

export const runtime = "nodejs";

/** GET /api/pos/registers/[id]/held-carts — carts parked at the register. */
export const GET = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json({
        carts: await listHeldCarts(authz.user.orgId, params.id, authz.allowedSubsidiaryIds ?? null),
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});

/** POST /api/pos/registers/[id]/held-carts — park the current cart to serve the next customer. */
export const POST = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  body: z
    .object({
      label: z.string().max(120),
      cart: z
        .object({
          customerId: uuidId.nullable().optional(),
          lines: z
            .array(
              z
                .object({
                  itemId: uuidId,
                  quantity: z.string().max(20),
                  unitPrice: z.string().max(24).nullable().optional(),
                  discount: z
                    .object({ kind: z.enum(["percent", "amount"]), value: z.string().max(24) })
                    .nullable()
                    .optional(),
                })
                .strict(),
            )
            .min(1)
            .max(200),
          orderDiscount: z
            .object({ kind: z.enum(["percent", "amount"]), value: z.string().max(24) })
            .nullable()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  handler: async ({ authz, params, body }) => {
    try {
      const held = await holdCart({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        registerId: params.id,
        label: body.label,
        cart: body.cart,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
      });
      return NextResponse.json(held, { status: 201 });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
