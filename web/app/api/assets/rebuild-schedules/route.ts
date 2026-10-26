import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import {
  hasActiveDepreciationBook,
  listVisibleDepreciationAssetNumbers,
} from "@openbooks/engine/assets/depreciation-route-queries";
import { buildSchedule } from "@openbooks/engine/assets/depreciation";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

// Typed body (never jsonObject: the financial-boundary ceiling only shrinks).
// Explicit operator-initiated rebuild for schedules the preview reports as
// stale: Confirm refuses while any in-scope schedule is stale, so the drawer
// offers this named remedy and then previews again.
const rebuildBody = z.strictObject({
  bookId: uuidString("bookId must be a valid id").nullable().optional(),
  assetIds: z
    .array(uuidString("assetIds must contain valid ids"), { error: "assetIds must be a list" })
    .min(1, "select at least one asset"),
});

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

export const POST = defineRoute({
  permission: "assets.manage",
  feature: "fixedAssets",
  body: rebuildBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const user = gate.user;

    const bookId = body.bookId?.trim().toLowerCase() || null;
    if (bookId) {
      if (!isUuid(bookId)) return bad("book_not_found", "bookId");
      if (!(await hasActiveDepreciationBook(user.orgId, bookId))) {
        return bad("book_not_found", "bookId");
      }
    }

    const rawIds = body.assetIds ?? [];
    const assetIds = [...new Set(rawIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    if (assetIds.length === 0) {
      return bad("nothing_selected", "assetIds");
    }
    if (assetIds.some((id) => !isUuid(id))) return bad("unknown_asset", "assetIds");

    // Tenant-owned and reader-visible, or the selection names nothing: a
    // foreign or out-of-scope id refuses rather than silently narrowing.
    const owned = await listVisibleDepreciationAssetNumbers({
      orgId: user.orgId,
      ids: assetIds,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    const byId = new Map(
      owned.map((row) => [String(row.id).toLowerCase(), String(row.asset_number)]),
    );
    const foreign = assetIds.find((id) => !byId.has(id));
    if (foreign) return bad("unknown_asset", "assetIds");

    const rebuilt: {
      assetId: string;
      assetNumber: string;
      scheduleId: string;
      lineCount: number;
      skippedMonths: string[];
    }[] = [];
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
          scheduleId: built.scheduleId,
          lineCount: built.lineCount,
          skippedMonths: built.skippedMonths,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        problems.push(`${byId.get(assetId) ?? assetId}: rebuild refused (${msg.slice(0, 160)})`);
      }
    }
    return NextResponse.json({ rebuilt, problems });
  },
});
