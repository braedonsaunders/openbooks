import { z } from "zod";
import { NextResponse } from "next/server";
import { recordCashMovement } from "@openbooks/engine/pos";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";
import { posIdempotencyKey } from "@/lib/pos";

export const runtime = "nodejs";

/**
 * POST /api/pos/sessions/[id]/movements — pay cash into or out of the open
 * drawer against a configured reason. The `Idempotency-Key` header makes a
 * retry return the movement already recorded.
 */
export const POST = defineRoute({
  permission: "pos.drawer",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  body: z
    .object({
      reasonId: uuidId,
      amount: z.string().trim().max(24),
      note: z.string().trim().max(500).nullable().optional(),
    })
    .strict(),
  handler: async ({ authz, params, body, request }) => {
    const key = posIdempotencyKey(request);
    if (!key)
      return NextResponse.json(
        {
          error: "The movement needs an Idempotency-Key header carrying a UUID.",
          code: "invalid_idempotency_key",
        },
        { status: 400 },
      );
    try {
      const movement = await recordCashMovement({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        sessionId: params.id,
        reasonId: body.reasonId,
        amount: body.amount,
        note: body.note ?? null,
        idempotencyKey: key,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
      });
      return NextResponse.json(movement, { status: movement.replayed ? 200 : 201 });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
