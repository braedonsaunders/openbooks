import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { listAssetGroupValuationRouteRows } from "@openbooks/engine/assets/asset-route-queries";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { proposeAssetGroupValuation } from "@openbooks/engine/assets/group-valuations";
import { isUuid } from "@/lib/list-params";
import { exactMoney } from "@/lib/api/json";
export const runtime = "nodejs";
const date = z.string().refine(isIsoCalendarDate, "enter a calendar date");
const proposal = z.object({
  sourceEventId: uuidString(),
  effectiveOn: date,
  carryingValue: exactMoney(),
  buyerToGroupRate: z.string().min(1).max(40),
  assessment: z.string().trim().min(8).max(4000),
  reason: z.string().trim().min(8).max(1000),
  idempotencyKey: z.string().min(1).max(120),
  remainingPlan: z.array(z.object({ date, amount: exactMoney() })).max(1200),
});
export const GET = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid asset" }, { status: 422 });
    const rows = (await listAssetGroupValuationRouteRows(gate.user.orgId, id)).filter(
      (row) =>
        !gate.allowedSubsidiaryIds ||
        (gate.allowedSubsidiaryIds.has(row.subsidiary_id) &&
          gate.allowedSubsidiaryIds.has(row.elimination_subsidiary_id)),
    );
    return NextResponse.json({
      events: rows.map((row) => ({
        id: row.id,
        date: row.date,
        kind: row.kind,
        amount: row.amount,
        book_name: row.book_name,
        group_currency: row.group_currency,
        recorded: row.recorded,
      })),
    });
  },
});
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  body: proposal,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid asset" }, { status: 422 });
    try {
      const changeId = await proposeAssetGroupValuation(gate.user.orgId, id, gate.user.id, body);
      return NextResponse.json({ changeId }, { status: 201 });
    } catch (error) {
      return apiErrorResponse(error, { safeStatus: 422 });
    }
  },
});
