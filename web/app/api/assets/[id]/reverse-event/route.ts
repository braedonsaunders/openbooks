import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  findVisibleReversibleAsset,
  listAssetReversibleEventRouteRows,
} from "@openbooks/engine/assets/asset-route-queries";
import { reverseAssetLifecycleEvent } from "@openbooks/engine/assets/asset-lifecycle";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { isUuid } from "@/lib/list-params";
import { isoDate } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  eventId: uuidString("eventId must be a valid id"),
  date: isoDate("date must be a valid calendar date"),
  reason: z
    .string()
    .trim()
    .min(8, "a reversal reason between 8 and 500 characters is required")
    .max(500),
});

export const runtime = "nodejs";

const REVERSIBLE_KINDS = ["revalued", "impaired", "disposed", "written_off"] as const;

type BlockReason =
  | "already_reversed"
  | "accounting_change"
  | "entry_not_posted"
  | "later_event"
  | "no_reversal_workflow";

/** Reversible-event candidates for the asset; advisory only, the engine
 *  decides on POST. The history read carries the subsidiary fence. */
export const GET = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid asset" }, { status: 422 });
    if (!(await findVisibleReversibleAsset(gate.user.orgId, id, gate.allowedSubsidiaryIds))) {
      return notFound("record");
    }

    const rows = await listAssetReversibleEventRouteRows(
      gate.user.orgId,
      id,
      gate.allowedSubsidiaryIds,
    );

    return NextResponse.json({
      events: rows.map((row) => {
        let blockReason: BlockReason | null = null;
        if (row.reversed) blockReason = "already_reversed";
        else if (row.financial_change_id) blockReason = "accounting_change";
        else if (!(REVERSIBLE_KINDS as readonly string[]).includes(row.kind))
          blockReason = "no_reversal_workflow";
        else if (row.entry_status !== "posted") blockReason = "entry_not_posted";
        else if (row.later_kind) blockReason = "later_event";
        return {
          id: row.id,
          kind: row.kind,
          occurredOn: row.occurred_on,
          amount: row.amount,
          entryNumber: row.entry_number,
          postingDate: row.posting_date,
          entryStatus: row.entry_status,
          reversible: blockReason === null,
          blockReason,
          laterKind: row.later_kind,
        };
      }),
    });
  },
});

/** Reverse a posted disposal or remeasurement via the engine; change-owned
 *  events stay on Accounting events. */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  invalidBodyStatus: 422,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid asset" }, { status: 422 });
    if (!(await findVisibleReversibleAsset(gate.user.orgId, id, gate.allowedSubsidiaryIds))) {
      return notFound("record");
    }

    const body = routeBody as {
      eventId?: string;
      date?: string;
      reason?: string;
    };
    if (!body.eventId || !isUuid(body.eventId)) {
      return NextResponse.json({ error: "select the lifecycle event to reverse" }, { status: 422 });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 8 || reason.length > 500) {
      return NextResponse.json(
        { error: "a reversal reason between 8 and 500 characters is required" },
        { status: 422 },
      );
    }
    if (body.date !== undefined && !isIsoCalendarDate(body.date)) {
      return NextResponse.json(
        { error: "date must be a valid calendar date (YYYY-MM-DD)" },
        { status: 422 },
      );
    }
    const date = body.date === undefined ? await businessToday(gate.user.orgId) : body.date;

    try {
      const result = await reverseAssetLifecycleEvent(gate.user.orgId, body.eventId, {
        date,
        actorId: gate.user.id,
        reason,
        assetId: id,
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
