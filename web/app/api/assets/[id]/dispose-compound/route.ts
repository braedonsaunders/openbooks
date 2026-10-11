import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { disposeCompoundAsset } from "@openbooks/engine/assets/asset-components";
import { calendarDate, id, optionalMoney, reasonText, scopeOf } from "../../_depth";

export const runtime = "nodejs";

const body = z.strictObject({
  date: calendarDate("date"),
  proceeds: optionalMoney("proceeds"),
  proceedsAccountId: id.nullable().optional(),
  writeOff: z.boolean().optional(),
  reason: reasonText,
});

/**
 * Dispose a parent asset and every remaining live component in one
 * transaction; each asset posts its own native disposal journal and the sale
 * price is apportioned by carrying value.
 */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "assetComponents",
  params: z.object({ id }),
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: input }) => {
    const { id: parentAssetId } = await params;
    try {
      const result = await disposeCompoundAsset(gate.user.orgId, {
        parentAssetId,
        date: input.date,
        proceeds: input.proceeds ?? "0",
        proceedsAccountId: input.proceedsAccountId ?? null,
        writeOff: input.writeOff === true,
        reason: input.reason,
        actorId: gate.user.id,
        allowedSubsidiaryIds: scopeOf(gate),
      });
      return NextResponse.json(result);
    } catch (error) {
      // Native disposal refusals (schedule tie, closed period, missing
      // gain/loss account) carry no status of their own.
      return apiErrorResponse(error, { safeStatus: 422 });
    }
  },
});
