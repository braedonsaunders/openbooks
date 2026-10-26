import { defineRoute } from "@/lib/api/route";
import { isoDate } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import {
  hasActiveDepreciationBook,
  listVisibleDepreciationAssetIds,
  loadDepreciationPeriodStart,
} from "@openbooks/engine/assets/depreciation-route-queries";
import { previewDepreciation } from "@openbooks/engine/assets/depreciation";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { isUuid } from "@/lib/list-params";
import { labelDepreciationPreview } from "@/lib/assets/period-labels";

export const runtime = "nodejs";

// Typed preview body (never jsonObject: the financial-boundary ceiling only
// shrinks). Read-only: this boundary performs SELECTs only — no locks, no
// schedule extension, no claims, no postings. Allocation and posting happen
// exclusively in POST /api/assets/run-depreciation after Confirm.
const previewBody = z.strictObject({
  bookId: uuidString("bookId must be a valid id").nullable().optional(),
  periodId: uuidString("periodId must be a valid id").nullable().optional(),
  throughDate: isoDate("throughDate must be a valid calendar date").nullable().optional(),
  postingDate: isoDate("postingDate must be a valid calendar date").nullable().optional(),
  assetIds: z.array(uuidString("assetIds must contain valid ids")).optional(),
});

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

/**
 * Read-only depreciation preview for the review/confirm drawer: the exact
 * balanced accounting impact of confirming the current selection, plus the
 * fingerprint Confirm must carry back. Stale schedules are REPORTED
 * (staleAssets + warnings), never extended here — Confirm extends them
 * first but posts only the previewed lines.
 */
export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  body: previewBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const user = gate.user;

    const throughDate = body.throughDate?.trim() || (await businessToday(user.orgId));
    if (!isIsoCalendarDate(throughDate)) {
      return bad("invalid_through_date", "throughDate");
    }

    const bookId = body.bookId?.trim().toLowerCase() || null;
    if (bookId) {
      if (!isUuid(bookId)) return bad("book_not_found", "bookId");
      if (!(await hasActiveDepreciationBook(user.orgId, bookId))) {
        return bad("book_not_found", "bookId");
      }
    }

    const periodId = body.periodId?.trim().toLowerCase() || null;
    if (periodId) {
      if (!isUuid(periodId)) return bad("period_not_found", "periodId");
      if (!(await loadDepreciationPeriodStart(user.orgId, periodId))) {
        return bad("period_not_found", "periodId");
      }
    }

    const postingDate = body.postingDate?.trim() || null;
    if (postingDate && !isIsoCalendarDate(postingDate)) {
      return bad("invalid_posting_date", "postingDate");
    }

    let assetIds: string[] | undefined;
    if (body.assetIds !== undefined) {
      const ids = [...new Set(body.assetIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
      if (ids.some((id) => !isUuid(id))) return bad("unknown_asset", "assetIds");
      if (ids.length > 0) {
        // Tenant-owned and reader-visible, or the selection names nothing:
        // a foreign or out-of-scope id refuses rather than silently narrowing.
        const found = await listVisibleDepreciationAssetIds({
          orgId: user.orgId,
          ids,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        });
        const seen = new Set(found.map((row) => String(row.id).toLowerCase()));
        if (ids.some((id) => !seen.has(id))) return bad("unknown_asset", "assetIds");
        assetIds = ids;
      } else {
        assetIds = [];
      }
    }

    try {
      const preview = await previewDepreciation(user.orgId, {
        asOfDate: throughDate,
        bookId: bookId ?? undefined,
        periodId: periodId ?? undefined,
        assetIds,
        postingDate: postingDate ?? undefined,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds
          ? [...gate.allowedSubsidiaryIds]
          : undefined,
      });
      return NextResponse.json(labelDepreciationPreview(preview, await getLocale()));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  },
});
