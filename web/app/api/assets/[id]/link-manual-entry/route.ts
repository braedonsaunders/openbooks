import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { linkManualDepreciationEntry } from "@openbooks/engine/assets/depreciation";
import { isUuid } from "../../../../../lib/list-params";

const postBodySchema0 = z.strictObject({
  lineId: uuidString("lineId must be a valid id"),
  entryId: uuidString("entryId must be a valid id"),
});

export const runtime = "nodejs";

/** Attach a posted hand journal entry as a schedule line's depreciation
 *  evidence, so a later run cannot post the same amount again. The link is
 *  the operator's attestation; the engine validates it is plausible (posted,
 *  unlinked, same book/period/subsidiary, exact debit/credit pair). */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid asset" }, { status: 422 });

    const body = routeBody as { lineId: string; entryId: string };
    try {
      const result = await linkManualDepreciationEntry(gate.user.orgId, id, {
        lineId: body.lineId,
        entryId: body.entryId,
        actorId: gate.user.id,
        ...(gate.allowedSubsidiaryIds
          ? { allowedSubsidiaryIds: [...gate.allowedSubsidiaryIds] }
          : {}),
      });
      return NextResponse.json({
        ...result,
        periodName: periodDisplayLabel(result.periodRef, await getLocale()),
      });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
