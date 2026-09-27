import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { disposeAsset } from "@openbooks/engine/src/assets/asset-lifecycle.ts";
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
const postBodySchema0 = z.discriminatedUnion("writeOff", [
  z.strictObject({
    date: isoDate("date must be a valid calendar date"),
    proceeds: exactMoney("proceeds must be a decimal string; JSON numbers are refused"),
    writeOff: z.literal(true),
  }),
  z.strictObject({
    date: isoDate("date must be a valid calendar date"),
    proceeds: exactMoney("proceeds must be a decimal string; JSON numbers are refused"),
    proceedsAccountId: z.string().uuid("proceedsAccountId must be a valid id").optional(),
    writeOff: z.literal(false),
  }),
]);

export { runtime } from "@/lib/api/route";

interface Body {
  date?: string;
  proceeds?: string;
  proceedsAccountId?: string;
  writeOff?: boolean;
}

/**
 * Dispose an asset by sale (or write it off): posts the disposal journal
 * (clear cost + accumulated, recognize proceeds, book gain/loss) and flips the
 * asset's status. Idempotency is enforced by the engine (an already-disposed
 * asset is rejected).
 */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  handler: async ({ request: req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid asset" }, { status: 422 });

    const body = routeBody as Body;
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
    const writeOff = body.writeOff === true;
    // The supplied proceeds pass through untouched — even on a write-off — so
    // the engine's own writeOff + nonzero-proceeds refusal fires instead of
    // this route silently coercing {writeOff: true, proceeds: 500} into a
    // zero-proceeds write-off reported as success.
    const proceedsRaw = canonicalDecimal(body.proceeds ?? "0", 4);
    if (
      proceedsRaw === null &&
      body.proceeds !== undefined &&
      body.proceeds !== null &&
      body.proceeds !== ""
    ) {
      return NextResponse.json(
        { error: moneyRefusal("Proceeds", body.proceeds) },
        { status: 422 },
      );
    }
    if (proceedsRaw === null || compareDecimal(proceedsRaw, "0") < 0) {
      return NextResponse.json(
        { error: "proceeds must be a non-negative amount" },
        { status: 422 },
      );
    }
    const proceeds = normalizeMoney(proceedsRaw);
    if (
      !writeOff &&
      compareDecimal(proceeds, "0") > 0 &&
      (!body.proceedsAccountId || !isUuid(body.proceedsAccountId))
    ) {
      return NextResponse.json(
        { error: "select the account the proceeds are deposited to" },
        { status: 422 },
      );
    }

    try {
      const result = await disposeAsset(gate.user.orgId, id, {
        proceeds,
        proceedsAccountId: body.proceedsAccountId ?? null,
        date,
        actorId: gate.user.id,
        writeOff,
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
