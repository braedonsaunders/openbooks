import { NextResponse } from "next/server";
import { loadDirectory, loadOrgChart } from "@openbooks/engine/src/hrm/org-chart.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { civilDate } from "../documents/bodies";

/**
 * GET /api/hrm/org-chart?asOf=YYYY-MM-DD[&root=...] — the tree, or
 * ?mode=directory[&search=...] — the people list. Readable with
 * hrm.employment.read OR hrm.self.read (fenced in the service); the
 * hrmOrgChart switch gates the surface.
 */
export async function GET(req: Request) {
  const hr = await guardPermission("hrm.employment.read");
  const actor = hr instanceof NextResponse ? await guardPermission("hrm.self.read") : hr;
  if (actor instanceof NextResponse) return actor;
  if (!(await isFeatureEnabled(actor.user.orgId, "hrm"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!(await isFeatureEnabled(actor.user.orgId, "hrmOrgChart"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const params = new URL(req.url).searchParams;
    if (params.get("mode") === "directory") {
      const requestedPage = params.get("page") == null ? 1 : Number(params.get("page"));
      if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
        return NextResponse.json({ error: "page must be a positive whole number" }, { status: 400 });
      }
      const directory = await loadDirectory({
        orgId: actor.user.orgId,
        actorId: actor.user.id,
        search: params.get("search") ?? undefined,
        page: requestedPage,
      });
      return NextResponse.json({
        directory: directory.entries,
        totalCount: directory.totalCount,
        page: directory.page,
        pageSize: directory.pageSize,
      });
    }
    // The default as-of is the org's business day, never the UTC day (which is
    // tomorrow in the evening for the Americas).
    const asOf = params.get("asOf") ?? (await businessToday(actor.user.orgId));
    if (!civilDate.safeParse(asOf).success) {
      return NextResponse.json({ error: "asOf must be YYYY-MM-DD" }, { status: 400 });
    }
    const chart = await loadOrgChart({
      orgId: actor.user.orgId,
      actorId: actor.user.id,
      asOf,
      rootEmploymentId: params.get("root") ?? undefined,
    });
    return NextResponse.json({ chart });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
