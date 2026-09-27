import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { remeasureAsset } from "@openbooks/engine/src/assets/asset-lifecycle.ts";
import {
  businessToday,
  isIsoCalendarDate,
} from "@openbooks/engine/src/platform/business-date.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { isUuid } from "../../../../../lib/list-params";
import {
  canonicalDecimal,
  compareDecimal,
} from "../../../../../lib/exact-decimal";
import { moneyRefusal } from "../../../../../lib/payroll-decimal-refusal";
import { exactMoney, isoDate } from "../../../../../lib/api/json";
const postBodySchema0 = z.strictObject({
  newCarryingValue: exactMoney("newCarryingValue must be a decimal string; JSON numbers are refused"),
  date: isoDate("date must be a valid calendar date"),
});

export { runtime } from "@/lib/api/route";

/** Revalue or impair an asset to a new carrying value: posts the adjustment and
 *  rebuilds the remaining depreciation schedule on the new basis. */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  handler: async ({ request: req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid asset" }, { status: 422 });

    const body = routeBody as { newCarryingValue?: string; date?: string };
    const carryingRaw = canonicalDecimal(body.newCarryingValue, 4);
    if (
      carryingRaw === null &&
      body.newCarryingValue !== undefined &&
      body.newCarryingValue !== null &&
      body.newCarryingValue !== ""
    ) {
      return NextResponse.json(
        { error: moneyRefusal("New carrying value", body.newCarryingValue) },
        { status: 422 },
      );
    }
    if (carryingRaw === null || compareDecimal(carryingRaw, "0") < 0) {
      return NextResponse.json(
        { error: "enter the new carrying value" },
        { status: 422 },
      );
    }
    const newCarryingValue = normalizeMoney(carryingRaw);
    if (body.date !== undefined && !isIsoCalendarDate(body.date)) {
      return NextResponse.json(
        { error: "date must be a valid calendar date (YYYY-MM-DD)" },
        { status: 422 },
      );
    }
    const date =
      body.date === undefined
        ? await businessToday(gate.user.orgId)
        : body.date;

    try {
      const result = await remeasureAsset(gate.user.orgId, id, {
        newCarryingValue,
        date,
        actorId: gate.user.id,
        ...(gate.allowedSubsidiaryIds
          ? { allowedSubsidiaryIds: [...gate.allowedSubsidiaryIds] }
          : {}),
      });
      return NextResponse.json(result);
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
