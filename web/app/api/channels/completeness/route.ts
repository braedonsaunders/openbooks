import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { commerceCloseChecks } from "@openbooks/engine/src/close/commerce-close.ts";

export const runtime = "nodejs";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Daily completeness for the channels dashboard tile: the same eight proofs
 * the month-end close runs, scoped to one UTC day. The storefront reads are
 * live, so a day with unreachable channels reports unverifiable, never clean.
 */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  handler: async ({ request: req, authz: gate }) => {
    const day = new URL(req.url).searchParams.get("day") ?? todayUtc();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return NextResponse.json({ error: "day must be a YYYY-MM-DD calendar date" }, { status: 400 });
    }
    const book = (
      await db.execute<{ id: string }>(sql`
        select id from accounting_books
         where org_id = ${gate.user.orgId} and is_primary and is_active and posts_gl
         limit 1`)
    ).rows[0];
    if (!book) {
      return NextResponse.json(
        { error: "no active primary posting book", remedy: "Activate the primary posting book under Accounting → Books." },
        { status: 422 },
      );
    }
    const checks = await commerceCloseChecks(
      gate.user.orgId,
      { startsOn: day, endsOn: day, bookId: book.id },
    );
    return NextResponse.json({
      day,
      checks: checks.map((check) => ({
        code: check.code,
        severity: check.severity,
        count: check.count,
        title: check.title,
        message: check.message,
        details: check.details ?? {},
      })),
    });
  },
});
