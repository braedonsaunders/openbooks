import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  buildAllSchedules,
  recordDepreciationInput,
} from "@openbooks/engine/assets/depreciation";
import { fitsLedgerRange } from "@openbooks/engine/money/money";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { isUuid } from "../../../../../lib/list-params";
import { exactMoney, isoDate } from "../../../../../lib/api/json";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  effectiveDate: isoDate("effectiveDate must be a valid calendar date"),
  kind: z.enum(["manual", "production_usage"]),
  value: exactMoney("value must be a decimal string; JSON numbers are refused")
    .refine(fitsLedgerRange, "value must fit within 15 whole digits and 4 decimal places"),
  memo: z.string().trim().max(2000),
  evidenceFileId: uuidString("evidenceFileId must be a valid id"),
  bookId: uuidString("bookId must be a valid id").optional(),
});

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  invalidBodyStatus: 422,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    const { effectiveDate, kind, value, memo, evidenceFileId, bookId } = routeBody;

    const visible = await db.execute(sql`
    select 1 from fixed_assets where id = ${id} and org_id = ${gate.user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
  `);
    if (!visible.rows[0])
      return notFound("record");

    // The scope rides into both locked writes: the visibility precheck above
    // races a concurrent PATCH moving the asset to a restricted subsidiary.
    const scope = gate.allowedSubsidiaryIds
      ? [...gate.allowedSubsidiaryIds]
      : undefined;
    try {
      await buildAllSchedules(id, gate.user.orgId, gate.user.id, scope);
      const result = await recordDepreciationInput({
        orgId: gate.user.orgId,
        assetId: id,
        bookId,
        effectiveDate,
        kind,
        value,
        memo,
        evidenceFileId,
        actorId: gate.user.id,
        allowedSubsidiaryIds: scope,
      });
      return NextResponse.json({
        ...result,
        periodName: periodDisplayLabel(result.periodRef, await getLocale()),
      });
    } catch (error) {
      return apiErrorResponse(error, { safeStatus: 422 });
    }
  },
});
