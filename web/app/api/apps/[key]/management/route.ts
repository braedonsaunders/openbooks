import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import { readAppManagementPage } from "@openbooks/engine/apps/management-read";

export const runtime = "nodejs";
/** Organization-scoped, bounded pages of immutable operational evidence. */
export const GET = defineRoute({
  permission: "apps.manage",
  feature: "apps",
  handler: async ({ request, authz: gate, params }) => {
    const { key } = params as { key: string };
    const query = new URL(request.url).searchParams;
    const section = query.get("section") ?? "versions";
    const result = await readAppManagementPage(db, {
      orgId: gate.user.orgId,
      key,
      section,
      pageQuery: query.get("page"),
    });
    if (result.kind === "not_found") return notFound("record");
    if (result.kind === "invalid_page")
      return NextResponse.json({ error: "Invalid page" }, { status: 400 });
    if (result.kind === "invalid_section")
      return NextResponse.json({ error: "Invalid section" }, { status: 400 });
    return NextResponse.json(
      {
        rows: result.rows.slice(0, 25),
        hasMore: result.rows.length > 25,
        page: result.page,
        activeVersionId: result.activeVersionId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
});
