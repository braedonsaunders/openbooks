import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { buildSchedule } from "@openbooks/engine/src/assets/depreciation.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

// Typed body (never jsonObject: the financial-boundary ceiling only shrinks).
// Explicit operator-initiated rebuild for schedules the preview reports as
// stale: Confirm refuses while any in-scope schedule is stale, so the drawer
// offers this named remedy and then previews again.
const rebuildBody = z.looseObject({
  bookId: z.string().optional().nullable(),
  assetIds: z.array(z.string()).optional(),
});

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

export async function POST(request: Request) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const user = gate.user;

  const parsedBody = await parseJsonBody(request, rebuildBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  const bookId = body.bookId?.trim().toLowerCase() || null;
  if (bookId) {
    if (!isUuid(bookId)) return bad("book_not_found", "bookId");
    const book = await db.execute(sql`
      select 1 from accounting_books
       where id = ${bookId} and org_id = ${user.orgId} and is_active
    `);
    if (!book.rows[0]) return bad("book_not_found", "bookId");
  }

  const rawIds = body.assetIds ?? [];
  const assetIds = [...new Set(rawIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (assetIds.length === 0) {
    return bad("nothing_selected", "assetIds");
  }
  if (assetIds.some((id) => !isUuid(id))) return bad("unknown_asset", "assetIds");

  // Tenant-owned and reader-visible, or the selection names nothing: a
  // foreign or out-of-scope id refuses rather than silently narrowing.
  const owned = await db.execute<{ id: string; asset_number: string }>(sql`
    select a.id, a.asset_number from fixed_assets a
     where a.org_id = ${user.orgId} and a.id = any(${`{${assetIds.join(",")}}`}::uuid[])
       ${gate.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])` : sql``}
  `);
  const byId = new Map(
    owned.rows.map((row) => [String(row.id).toLowerCase(), String(row.asset_number)]),
  );
  const foreign = assetIds.find((id) => !byId.has(id));
  if (foreign) return bad("unknown_asset", "assetIds");

  const rebuilt: { assetId: string; assetNumber: string; lineCount: number }[] = [];
  const problems: string[] = [];
  for (const assetId of assetIds) {
    try {
      // The scope rides into the locked build: the ownership precheck above
      // races a concurrent PATCH moving the asset to a restricted subsidiary.
      const built = await buildSchedule(
        assetId,
        user.orgId,
        user.id,
        bookId ?? undefined,
        gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
      );
      rebuilt.push({
        assetId,
        assetNumber: byId.get(assetId) ?? assetId,
        lineCount: built.lineCount,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(`${byId.get(assetId) ?? assetId}: rebuild refused (${msg.slice(0, 160)})`);
    }
  }
  return NextResponse.json({ rebuilt, problems });
}
