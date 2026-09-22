import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  previewDepreciation,
} from "@openbooks/engine/src/assets/depreciation.ts";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

// Typed preview body (never jsonObject: the financial-boundary ceiling only
// shrinks). Read-only: this boundary performs SELECTs only — no locks, no
// schedule extension, no claims, no postings. Allocation and posting happen
// exclusively in POST /api/assets/run-depreciation after Confirm.
const previewBody = z.looseObject({
  bookId: z.string().optional().nullable(),
  periodId: z.string().optional().nullable(),
  throughDate: z.string().optional().nullable(),
  postingDate: z.string().optional().nullable(),
  assetIds: z.array(z.string()).optional(),
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
export async function POST(request: Request) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const parsedBody = await parseJsonBody(request, previewBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  const throughDate = body.throughDate?.trim() || (await businessToday(user.orgId));
  if (!isIsoCalendarDate(throughDate)) {
    return bad("invalid_through_date", "throughDate");
  }

  const bookId = body.bookId?.trim().toLowerCase() || null;
  if (bookId) {
    if (!isUuid(bookId)) return bad("book_not_found", "bookId");
    const book = await db.execute(sql`
      select 1 from accounting_books
       where id = ${bookId} and org_id = ${user.orgId} and is_active
    `);
    if (!book.rows[0]) return bad("book_not_found", "bookId");
  }

  const periodId = body.periodId?.trim().toLowerCase() || null;
  if (periodId) {
    if (!isUuid(periodId)) return bad("period_not_found", "periodId");
    const period = await db.execute<{ starts_on: string }>(sql`
      select starts_on::text as starts_on from accounting_periods
       where id = ${periodId} and org_id = ${user.orgId} and not is_adjustment
    `);
    if (!period.rows[0]) return bad("period_not_found", "periodId");
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
      const found = await db.execute<{ id: string }>(sql`
        select a.id from fixed_assets a
         where a.org_id = ${user.orgId} and a.id = any(${`{${ids.join(",")}}`}::uuid[])
           ${gate.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
      `);
      const seen = new Set(found.rows.map((row) => String(row.id).toLowerCase()));
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
    return NextResponse.json(preview);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
